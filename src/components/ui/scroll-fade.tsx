// Scroll Fade, after Animate UI's: an edge with content past it dissolves
// (a mask, so it works on any background), and the items near it shrink and
// blur slightly. Scrolling never re-renders React. The app's lists take it
// from here, so its depth is set in one place.
import * as React from "react"
import {
  ScrollFade as ScrollFadePrimitive,
  useScrollFade as useScrollFadePrimitive,
  type UseScrollFadeOptions,
} from "@animate-ui/react/primitives/effects/scroll-fade"

// Shallower than the library's 40 px: the app's rows are dense.
const DEFAULTS: UseScrollFadeOptions = { size: 32 }

/** A scroll container whose edges fade. */
function ScrollFade(props: React.ComponentProps<typeof ScrollFadePrimitive>) {
  return <ScrollFadePrimitive data-slot="scroll-fade" {...DEFAULTS} {...props} />
}

/** Fades an element that is always mounted and already scrolls. */
function useScrollFade(ref: React.RefObject<HTMLElement | null>, options?: UseScrollFadeOptions) {
  return useScrollFadePrimitive(ref, { ...DEFAULTS, ...options })
}

/**
 * Fades an element that mounts later or anew, such as a menu's viewport in a
 * portal: the returned callback ref follows the element as it changes.
 */
function useScrollFadeRef<T extends HTMLElement>(options?: UseScrollFadeOptions) {
  const [element, setElement] = React.useState<T | null>(null)
  // A new object per element, so the fade attaches again to each one.
  const ref = React.useMemo(() => ({ current: element }), [element])
  useScrollFade(ref, options)
  return setElement
}

export { ScrollFade, useScrollFade, useScrollFadeRef }
