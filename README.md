# Turbo Stream Animations

Animates elements as they enter, change, or exit during Turbo Stream actions
(`append`, `prepend`, `before`, `after`, `replace`, `update`, `remove`).

A counterpart to [`turbo-refresh-animations`](https://github.com/firstdraft/turbo-refresh-animations) — same opt-in attribute style, same default class names, same animation runner internals — but for the Turbo Stream pipeline rather than page-refresh morphs.

## Table of contents

- [The problem](#the-problem)
- [Quick start](#quick-start)
- [Data attributes reference](#data-attributes-reference)
- [Action → phase mapping](#action--phase-mapping)
- [How it works](#how-it-works)
- [Design decisions](#design-decisions)
- [Alternatives we evaluated](#alternatives-we-evaluated)
- [When *not* to use this library](#when-not-to-use-this-library)
- [Compatibility with `turbo-refresh-animations`](#compatibility-with-turbo-refresh-animations)
- [Limitations](#limitations)

## The problem

Animating Turbo Stream inserts and removals looks easy and is sneakily not. Two constraints define a correct solution:

1. **No animation on initial SSR.** A page that loads with 50 existing items should render them statically. Only inserts that happen *after* page load should animate in.
2. **Removals must wait for the animation to finish.** If you add a `.fade-out` class and call `.remove()` in the same tick, the browser never paints the intermediate state and the row disappears instantly.

CSS alone can't satisfy constraint 1. A keyframe animation on the partial root, or a `transition` paired with `@starting-style`, runs *every* time the element first renders — and from CSS's perspective, an SSR-rendered node and a stream-inserted node are equally first renders. Distinguishing them requires JavaScript that runs in one context and not the other.

This library hooks `turbo:before-stream-render`, which by definition only fires for stream actions. SSR is automatically excluded. For removals, it uses Turbo's `await newElement.performAction()` contract (see [`turbo/src/elements/stream_element.js`](https://github.com/hotwired/turbo/blob/main/src/elements/stream_element.js)) to delay the actual `.remove()` until the animation completes.

## Quick start

```js
// app/javascript/application.js
import "@hotwired/turbo-rails"
import "turbo-stream-animations"
```

Add CSS. The library ships no visual styles — it only adds class names.

```css
.turbo-stream-enter { animation: fade-in 200ms ease-out; }
.turbo-stream-exit  { animation: fade-out 200ms ease-out forwards; }

@keyframes fade-in  { from { opacity: 0 } to { opacity: 1 } }
@keyframes fade-out { from { opacity: 1 } to { opacity: 0 } }

@media (prefers-reduced-motion: reduce) {
  .turbo-stream-enter, .turbo-stream-exit {
    animation-duration: 1ms;
  }
}
```

See [`example.css`](./example.css) for a complete example including a "change" highlight.

Opt elements in by adding `data-turbo-stream-animate` and an `id`:

```erb
<%# app/views/messages/_message.html.erb %>
<div id="<%= dom_id(message) %>" data-turbo-stream-animate>
  <%= message.body %>
</div>
```

That's it. Stream actions that touch this partial now animate:

```ruby
turbo_stream.append  "messages", partial: "messages/message", locals: { message: @m }   # enter
turbo_stream.replace @m, partial: "messages/message", locals: { message: @m }           # change
turbo_stream.remove  @m                                                                  # exit (removal delayed)

# Model broadcasts work too — no extra config:
class Message < ApplicationRecord
  broadcasts_to ->(m) { [m.room, "messages"] }
end
```

The same partial is rendered during SSR and is unaffected — the listener doesn't fire during page load.

## Data attributes reference

| Attribute | Purpose |
|-----------|---------|
| `id` | Required for stream targeting (Turbo's requirement, not ours) |
| `data-turbo-stream-animate` | Opt-in. Present/`""` enables all phases. `"enter,exit"` enables a subset. `"none"` or `"false"` disables. |
| `data-turbo-stream-enter` | Override enter class for this element |
| `data-turbo-stream-change` | Override change class for this element |
| `data-turbo-stream-exit` | Override exit class for this element |

```erb
<%# Subset: only animate exits %>
<div id="..." data-turbo-stream-animate="exit">

<%# Per-element class overrides %>
<div id="..."
     data-turbo-stream-animate
     data-turbo-stream-enter="slide-in-down"
     data-turbo-stream-exit="slide-out-up">

<%# Disable on a specific element when a wrapper sets the attr by default %>
<div id="..." data-turbo-stream-animate="none">
```

## Action → phase mapping

| Stream action                          | Phase  | Default class           |
|----------------------------------------|--------|-------------------------|
| `append`, `prepend`, `before`, `after` | enter  | `turbo-stream-enter`    |
| `replace`, `update`                    | change | `turbo-stream-change`   |
| `remove`                               | exit   | `turbo-stream-exit`     |
| `refresh`                              | —      | (delegated to [`turbo-refresh-animations`](https://github.com/firstdraft/turbo-refresh-animations) if installed) |

## How it works

The library installs one listener on `turbo:before-stream-render`. For each stream:

1. Look up the action's phase (enter / change / exit). If the action is unknown or has no mapped phase, do nothing.
2. Wrap `event.detail.render` with an async function.

For **exit**, the wrapped render:
- Collects the target elements (`streamElement.targetElements`).
- Filters to those with `data-turbo-stream-animate` enabling exit.
- Adds the exit class and `await`s an animation runner that resolves on `animationend` / `transitionend` / cancel events, or on a timeout fallback.
- _Then_ delegates to Turbo's original render (which actually removes the node).

For **enter** and **change**, the wrapped render:
- Snapshots the target's children before insertion.
- Delegates to Turbo's original render.
- Diffs the children to find newly-inserted nodes.
- For each opted-in newly-inserted element, adds the phase class. (For `replace`, also re-resolves by id, since the new element doesn't appear as a "new child" of the parent — it replaces an old element with the same id.)

Turbo `await`s `event.detail.render` ([`stream_element.js:49`](https://github.com/hotwired/turbo/blob/main/src/elements/stream_element.js)), which means the next stream action does not start until our wrapped render resolves. For exit, this gives us correct sequencing: the animation completes before the node is gone, and any subsequent stream targeting siblings runs in a clean state.

### The animation runner

The runner is the same shape as [`turbo-refresh-animations`](https://github.com/firstdraft/turbo-refresh-animations/blob/main/turbo-refresh-animations.js). For each element:

1. Add the phase class.
2. Read computed style to count expected `animationend` / `transitionend` events and compute a maximum duration (delay + duration × iterations + 50 ms grace).
3. Listen for `animationend`, `animationcancel`, `transitionend`, `transitioncancel`. Filter to events where `e.target === element` (a child finishing its own animation must not satisfy the parent's wait).
4. Resolve when the expected end count is reached, when a cancel fires, or when the timeout fires (whichever comes first).
5. If the class triggers no animation or transition at all (zero expected ends, zero computed duration), resolve immediately rather than waiting 2 s.

The 2 s ceiling is a safety net for when computed-style introspection fails (unusual `animation: none` overrides, browser quirks). Real apps with fast animations will typically resolve in tens of milliseconds via the events themselves.

## Design decisions

### Enter and change don't `await` the animation; exit does

Exit *must* block the render: if it didn't, Turbo would call `.remove()` synchronously and the browser would never paint a frame with the exit class applied. The animation needs the node to stay in the tree until completion.

Enter and change have no such requirement. The new content is already in the DOM after `originalRender(el)` returns; the user can see it. Awaiting the enter animation would stall *subsequent* streams behind a 200 ms flourish for no benefit. So the library applies the class and lets the animation play in the background.

This means rapid-fire enters can overlap (multiple items animating in concurrently), which is usually what you want. If you need staggered enters, that's a CSS concern (`animation-delay: calc(var(--i) * 50ms)`), not a library concern.

### We snapshot `target.children`, not `templateContent`

[`stream_element.js:125`](https://github.com/hotwired/turbo/blob/main/src/elements/stream_element.js) defines `templateContent` as `this.templateElement.content.cloneNode(true)`. Each access returns a *fresh clone*. We can't grab a reference from `templateContent` and find that same node in the DOM after render — it isn't the same node. The library snapshots the target container's `children` set before render and diffs after. Simpler and reliable.

### Opt-in is required, not default

The library could plausibly animate every stream-inserted element automatically. It deliberately doesn't. Reasons:

- Many apps stream content the user shouldn't notice (e.g. background updates, virtual scroll). Implicit animation on those is jarring.
- Implicit animation makes a global library hard to remove later — every visual decision in the app implicitly depends on it.
- The opt-in attribute is short and lives on the partial. The cost is one attribute per animated component, paid once.

Required opt-in mirrors `turbo-refresh-animations` and matches the broader Hotwire philosophy of explicit markup over implicit behavior.

### Class names default per phase, not per action

You get three classes: `turbo-stream-enter`, `turbo-stream-change`, `turbo-stream-exit`. Not seven for `append`/`prepend`/`before`/`after`/`replace`/`update`/`remove`. The visual distinction between "added at top" vs "added at bottom" is rarely meaningful enough to warrant separate styles, and per-element overrides cover the cases where it is.

## Alternatives we evaluated

We considered five other approaches before settling on this design. Each has merits; this section explains where each falls short for the general case.

### 1. Hand-rolled `turbo:before-stream-render` listener

A small (~15 line) listener that monkey-patches `event.detail.render` to add classes around insertion or before removal. Works, and is what most blog posts about Hotwire animations show.

**Where it falls short:** typically gets the timing wrong in subtle ways. Common bugs we saw in real implementations:
- `target.addEventListener("animationend", fn, { once: true })` fires on the *first* animation it sees, including bubbled events from descendants. Add an animated icon to the partial and removal starts breaking.
- No fallback timeout. If the animation doesn't fire (cancelled, `display: none`, motion-reduction CSS), the row stays in the DOM with the class applied indefinitely.
- No `animationcancel` listener. Animations interrupted by JS or DOM changes leave promises unresolved.
- Global "animate every append" coupling — every insert in the app animates, even ones that shouldn't.

This library is, in effect, the productized version of that listener with the bugs fixed and per-element opt-in added.

### 2. Caller passes `animated: true` as a local

Render the partial with the animation class only when streamed:

```ruby
turbo_stream.append "messages", partial: "messages/message",
  locals: { message: @m, animated: true }
```

```erb
<div class="message <%= 'fade-in' if local_assigns[:animated] %>">
```

**Strengths:** zero JavaScript, zero Turbo coupling, explicit at the call site.

**Where it falls short:** every call site has to pass the flag. Doesn't compose with `broadcasts_to` on a model — the model doesn't know the rendering context. Doesn't solve removal at all (CSS classes on a removed element have nowhere to animate to before the node is gone). Fine for an app with a handful of explicit appends; awkward for an app driven by model broadcasts or many stream sources.

### 3. Custom element wrapper: `<turbo-transition>`

[Rails Designer's `turbo-transition`](https://github.com/Rails-Designer/turbo-transition) is a Web Component. Animation runs on `connectedCallback` (enter) and `remove()` is overridden to clone-and-animate (exit). SSR distinction is solved by *placement*: enter wrappers go in the stream template only, leave wrappers go in the partial but with leave-only classes.

**Strengths:** source-agnostic (any DOM insertion path: streams, frames, manual JS, navigation). Polished animation lifecycle borrowed from Vue (three-phase classes, double-rAF, `getAnimations().finished`).

**Where it falls short:** markup overhead — every animated element is wrapped in `<turbo-transition>` either at the call site or in the partial. For a stream-only app this is heavier than a single attribute. The leave-by-cloning trick is invisible: debugging issues like "event listener stopped working" requires understanding that the original node was swapped for a clone.

If you genuinely need source-agnostic animation (frames *and* streams *and* manual JS), `<turbo-transition>` is the better tool. For stream-only flows, this library is leaner.

### 4. Custom `StreamActions` action (TurboPower-style)

Register a single async action and call it from Rails:

```js
StreamActions.fade_then_remove = async function () {
  await Promise.all(this.targetElements.map(animate))
  this.targetElements.forEach((el) => el.remove())
}
```

```ruby
turbo_stream.fade_then_remove(@item)
```

**Strengths:** named at the call site. Uses Turbo's documented extension point. Composes naturally with [TurboPower](https://github.com/marcoroth/turbo_power) for non-animation actions.

**Where it falls short:** every transition style (`fade_then_remove`, `slide_then_remove`, `scale_then_remove`, …) is its own action. The catalog grows. Per-element variation requires either more actions or attribute parameterization. Doesn't solve enter on its own.

A single named action is the right answer for one transition type. This library is the right answer when you have several or want them applied uniformly.

### 5. `turbo-refresh-animations`

Different problem domain. Hooks `turbo:before-render` / `turbo:render` for page refresh morphs. Will *not* fire for `turbo_stream.append` / `replace` / `remove`. See [Compatibility](#compatibility-with-turbo-refresh-animations) below.

## When *not* to use this library

- **You're not using Turbo Streams.** If your app drives updates via `turbo_refreshes_with method: :morph` and `broadcasts_refreshes_to`, use [`turbo-refresh-animations`](https://github.com/firstdraft/turbo-refresh-animations) instead.
- **You only have one or two transitions, and you want them named explicitly.** Custom `StreamActions` (option 4 above) gives you `turbo_stream.fade_then_remove(@item)` at the call site, which can be more discoverable than a global opt-in attribute on the partial.
- **You need to animate insertions from non-stream sources** (Turbo Frames, manual JS, page navigation). This library only sees stream actions. Use [`<turbo-transition>`](https://github.com/Rails-Designer/turbo-transition) for source-agnostic coverage.
- **You only have static appends from a single explicit caller.** Passing `animated: true` as a local (option 2 above) requires nothing on the client.

## Compatibility with `turbo-refresh-animations`

The two libraries can be used together without conflict:

- They listen to disjoint events: `turbo:before-stream-render` vs `turbo:before-render` / `turbo:render` / `turbo:before-morph-element`.
- Default class names are distinct: `turbo-stream-*` vs `turbo-refresh-*`.
- Opt-in attributes are distinct: `data-turbo-stream-animate` vs `data-turbo-refresh-animate`.

To share visual styling across both, alias classes in CSS:

```css
.turbo-stream-enter, .turbo-refresh-enter, .my-enter {
  animation: my-enter 200ms ease-out;
}
.turbo-stream-exit, .turbo-refresh-exit, .my-exit {
  animation: my-exit 200ms ease-out forwards;
}
```

The opt-in attributes are intentionally separate. An element may legitimately want to animate during streams but not morphs (or vice versa) — for example, a form whose state should be preserved during external broadcasts but should fade in on first append.

## Limitations

- **`<turbo-stream action="refresh">` is ignored.** Refresh streams trigger morphs, which are `turbo-refresh-animations`'s domain. If both libraries are installed, refresh streams animate via the morph library; if only this one is installed, refresh streams render without animation.
- **No FLIP move animations.** When `replace` reorders an element, it snaps to the new position. Add [`turbo-refresh-animations`](https://github.com/firstdraft/turbo-refresh-animations) and switch to morph-based replaces for FLIP support, or implement reordering via a different mechanism.
- **No form preservation.** Streams don't have an external-broadcast-vs-self problem the way morphs do, so the library has no `data-turbo-stream-preserve` analog.
- **Computed-style timeout assumes the animation/transition is set on the element itself.** If the phase class triggers an animation on a *child* via a descendant selector (`.turbo-stream-enter > .child { animation: ... }`), the parent's computed style shows no animation and the runner will resolve immediately without waiting. Apply the animation directly to the element with the class, or wait via the descendant: structure your CSS so the class and the animation are on the same element.
- **Multiple animations on one element.** Counted via comma-separated `animation-name`. Mixing keyframe animations and CSS transitions on the same element works, but the timing introspection takes the max — uneven durations resolve at the longest one.
