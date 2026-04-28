// ========== TURBO STREAM ANIMATIONS ==========
// Animates elements during Turbo Stream actions (append, prepend, before, after,
// replace, update, remove). The library only acts when the inserted/targeted
// elements opt in via `data-turbo-stream-animate`, so initial SSR renders are
// untouched -- the listener simply doesn't run during page load.

const canInstall = typeof window !== "undefined" && typeof document !== "undefined"

if (canInstall && !window.TurboStreamAnimationsInstalled) {
  window.TurboStreamAnimationsInstalled = true

const ATTR = "data-turbo-stream-animate"
const ATTR_PHASE = (phase) => `data-turbo-stream-${phase}`

const DEFAULT_PHASE_CLASSES = {
  enter:  "turbo-stream-enter",
  change: "turbo-stream-change",
  exit:   "turbo-stream-exit"
}

// Every animated element also receives an action-specific class
// (turbo-stream-append, -prepend, -before, -after, -replace, -update, -remove)
// so users can target a specific action without having to differentiate
// elements another way. The phase class is the umbrella; the action class
// lets you be more specific when you need to.
const DEFAULT_ACTION_CLASSES = {
  append:  "turbo-stream-append",
  prepend: "turbo-stream-prepend",
  before:  "turbo-stream-before",
  after:   "turbo-stream-after",
  replace: "turbo-stream-replace",
  update:  "turbo-stream-update",
  remove:  "turbo-stream-remove"
}

// Stream action -> animation phase. Actions not listed are ignored
// ("refresh" is delegated to turbo-refresh-animations if present).
const ACTION_PHASE = {
  append:  "enter",
  prepend: "enter",
  before:  "enter",
  after:   "enter",
  replace: "change",
  update:  "change",
  remove:  "exit"
}

document.addEventListener("turbo:before-stream-render", (event) => {
  const streamEl = event.target
  const phase = ACTION_PHASE[streamEl.action]
  if (!phase) return

  const originalRender = event.detail.render

  if (phase === "exit") {
    event.detail.render = async (el) => {
      const action = el.action
      const targets = collectExitTargets(el).filter((t) => shouldAnimate(t, "exit"))
      if (targets.length === 0) return originalRender(el)

      await Promise.all(targets.map((t) =>
        runAnimation(t, classesFor(t, "exit", action), { keepClasses: true })
      ))
      await originalRender(el)
    }
    return
  }

  // enter / change: render first, then class the resulting nodes
  event.detail.render = async (el) => {
    const action = el.action
    const before = snapshotChildren(el)
    await originalRender(el)
    const newNodes = newlyInsertedNodes(el, before, phase)
    newNodes.forEach((node) => runAnimation(node, classesFor(node, phase, action)))
    // Animation runs in the background; the stream pipeline does not block on
    // enter/change. (Blocking would delay subsequent streams behind the animation
    // for no benefit -- the new content is already visible.)
  }
})

// ========== TARGET COLLECTION ==========

function collectExitTargets(streamEl) {
  // streamEl.targetElements is what Turbo itself uses; reuse it where possible.
  if (Array.isArray(streamEl.targetElements)) return [...streamEl.targetElements]

  const id = streamEl.getAttribute("target")
  if (id) {
    const el = document.getElementById(id)
    return el ? [el] : []
  }
  const selector = streamEl.getAttribute("targets")
  if (selector) return [...document.querySelectorAll(selector)]
  return []
}

// For enter/change actions, identify the elements that were just inserted.
// We snapshot the target's relevant children before render and diff after.
// This avoids relying on streamEl.templateContent, which returns a fresh clone
// each access -- the nodes actually in the DOM are not the same references.
function snapshotChildren(streamEl) {
  const targets = relevantContainers(streamEl)
  return targets.map((container) => ({
    container,
    children: new Set(container.children)
  }))
}

function newlyInsertedNodes(streamEl, before, phase) {
  const phaseToMatch = phase
  const result = []
  for (const { container, children } of before) {
    for (const child of container.children) {
      if (children.has(child)) continue
      if (shouldAnimate(child, phaseToMatch)) result.push(child)
      // Also pick up opted-in descendants in case the partial wraps animated
      // children inside a non-animated root.
      child.querySelectorAll?.(`[${ATTR}]`)
        .forEach((nested) => {
          if (shouldAnimate(nested, phaseToMatch)) result.push(nested)
        })
    }
  }

  // For `replace`, the new element replaces the old at the same id and may not
  // appear as a "new child" if container was the parent. Re-resolve by id.
  if (streamEl.action === "replace") {
    const id = streamEl.getAttribute("target")
    if (id) {
      const replacement = document.getElementById(id)
      if (replacement && shouldAnimate(replacement, phaseToMatch) && !result.includes(replacement)) {
        result.push(replacement)
      }
    }
  }

  return result
}

// Containers whose children we need to diff for newly-inserted nodes.
function relevantContainers(streamEl) {
  const action = streamEl.action

  if (action === "append" || action === "prepend" || action === "update") {
    return collectExitTargets(streamEl)
  }
  if (action === "before" || action === "after" || action === "replace") {
    // Inserts/replaces happen at the parent level
    return collectExitTargets(streamEl)
      .map((t) => t.parentElement)
      .filter(Boolean)
  }
  return []
}

// ========== OPT-IN PARSING ==========

function shouldAnimate(element, phase) {
  if (!element || element.nodeType !== 1) return false
  const value = element.getAttribute(ATTR)
  if (value === null) return false
  if (value === "none" || value === "false") return false
  if (value === "" || value === "true") return true
  return value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean).includes(phase)
}

function classesFor(element, phase, action) {
  // Phase class: overridable per-element via data-turbo-stream-{phase}.
  // Action class: always the default name. Per-element customization for an
  // action is best done via CSS selectors against the action class.
  const phaseClass = element.getAttribute(ATTR_PHASE(phase)) || DEFAULT_PHASE_CLASSES[phase]
  const actionClass = DEFAULT_ACTION_CLASSES[action]
  return actionClass ? [phaseClass, actionClass] : [phaseClass]
}

// ========== ANIMATION RUNNER ==========
// Mirrors the timing logic from turbo-refresh-animations: counts expected
// animation/transition ends, listens for both end and cancel, and falls back
// to a computed-style-derived timeout. Filters bubbled events from descendants.

function runAnimation(element, classes, options = {}) {
  return new Promise((resolve) => {
    const { keepClasses = false } = options
    let finished = false
    let timer = null
    let endedCount = 0
    let expectedEnds = 0

    const finish = () => {
      if (finished) return
      finished = true
      if (timer) clearTimeout(timer)
      element.removeEventListener("animationend", onEnd)
      element.removeEventListener("animationcancel", onCancel)
      element.removeEventListener("transitionend", onEnd)
      element.removeEventListener("transitioncancel", onCancel)
      // For enter/change we remove the classes once the animation is done.
      // For exit (keepClasses: true) we leave them on -- the element is about
      // to be removed from the DOM anyway.
      if (!keepClasses) element.classList.remove(...classes)
      resolve()
    }
    const onEnd = (e) => {
      if (e.target !== element) return // ignore bubbles from descendants
      endedCount += 1
      if (expectedEnds > 0 && endedCount >= expectedEnds) finish()
    }
    const onCancel = (e) => {
      if (e.target !== element) return
      finish()
    }

    element.addEventListener("animationend", onEnd)
    element.addEventListener("animationcancel", onCancel)
    element.addEventListener("transitionend", onEnd)
    element.addEventListener("transitioncancel", onCancel)

    element.classList.add(...classes)

    expectedEnds = expectedAnimationEndCount(element) + expectedTransitionEndCount(element)
    const waitMs = maxWaitMsForAnimationOrTransition(element)

    if (expectedEnds === 0 && waitMs === 0) {
      // Class didn't trigger any animation or transition; nothing to wait for.
      finish()
      return
    }

    timer = setTimeout(finish, waitMs > 0 ? waitMs : 2000)
  })
}

// ========== CSS TIMING INTROSPECTION ==========

function expectedAnimationEndCount(el) {
  const style = getComputedStyle(el)
  if (!style.animationName || style.animationName === "none") return 0
  return style.animationName.split(",").filter((n) => n.trim() !== "none").length
}

function expectedTransitionEndCount(el) {
  const style = getComputedStyle(el)
  if (!style.transitionProperty || style.transitionProperty === "none") return 0
  const durations = parseCssTimeListMs(style.transitionDuration)
  return durations.filter((d) => d > 0).length
}

function maxWaitMsForAnimationOrTransition(el) {
  const style = getComputedStyle(el)
  let maxMs = 0

  if (style.animationName && style.animationName !== "none") {
    maxMs = Math.max(maxMs, maxTimingMs(
      parseCssTimeListMs(style.animationDuration),
      parseCssTimeListMs(style.animationDelay),
      parseCssNumberList(style.animationIterationCount)
    ))
  }
  if (style.transitionProperty && style.transitionProperty !== "none") {
    maxMs = Math.max(maxMs, maxTimingMs(
      parseCssTimeListMs(style.transitionDuration),
      parseCssTimeListMs(style.transitionDelay),
      [1]
    ))
  }
  // 50ms grace for the events to actually fire
  return maxMs > 0 ? maxMs + 50 : 0
}

function parseCssTimeListMs(value) {
  if (!value) return [0]
  return value.split(",").map((token) => {
    const t = token.trim()
    if (t.endsWith("ms")) return parseFloat(t)
    if (t.endsWith("s")) return parseFloat(t) * 1000
    return parseFloat(t) || 0
  })
}

function parseCssNumberList(value) {
  if (!value) return [1]
  return value.split(",").map((t) => {
    const n = parseFloat(t.trim())
    return Number.isFinite(n) ? n : 1
  })
}

function maxTimingMs(durations, delays, iterations) {
  let maxMs = 0
  const len = Math.max(durations.length, delays.length, iterations.length)
  for (let i = 0; i < len; i++) {
    const dur = durations[i % durations.length] || 0
    const del = delays[i % delays.length] || 0
    const iter = iterations[i % iterations.length] || 1
    // Infinite iterations (`infinite`) come through as NaN; cap at the first cycle.
    const effectiveIter = Number.isFinite(iter) && iter > 0 ? iter : 1
    maxMs = Math.max(maxMs, del + dur * effectiveIter)
  }
  return maxMs
}

} // end install guard
