"use client"

import * as React from "react"
import { useLayoutEffect, useRef, useState } from "react"
import { cn } from "@/lib/utils"

interface Tab {
  id: string
  label: React.ReactNode
}

interface TabsProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "onChange"> {
  tabs: readonly Tab[]
  activeTab?: string
  onTabChange?: (tabId: string) => void
  // The row inside the scroller, which draws the line under the tabs.
  listClassName?: string
}

type Box = { left: number; width: number }

// The app's colours (accent fill on hover, the brand's line under the active
// tab) and a 36 px bar like its other strips. The tabs are buttons in a
// tablist: Tab reaches the active one, the arrow keys move between them.
// The bar scrolls sideways when the tabs are wider than their place.
const Tabs = React.forwardRef<HTMLDivElement, TabsProps>(
  ({ className, listClassName, tabs, activeTab, onTabChange, "aria-label": ariaLabel, ...props }, ref) => {
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
    const [ownActive, setOwnActive] = useState(tabs[0]?.id)
    const active = activeTab ?? ownActive
    const activeIndex = Math.max(0, tabs.findIndex((tab) => tab.id === active))
    const [hoverBox, setHoverBox] = useState<Box | null>(null)
    const [activeBox, setActiveBox] = useState<Box | null>(null)
    // No slide on the first paint: the line appears under its tab.
    const [placed, setPlaced] = useState(false)
    const listRef = useRef<HTMLDivElement>(null)
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

    const boxOf = (index: number): Box | null => {
      const element = tabRefs.current[index]
      return element ? { left: element.offsetLeft, width: element.offsetWidth } : null
    }

    useLayoutEffect(() => {
      if (hoveredIndex !== null) setHoverBox(boxOf(hoveredIndex))
    }, [hoveredIndex])

    // Again whenever a label or the bar's size changes.
    useLayoutEffect(() => {
      const place = () => setActiveBox(boxOf(activeIndex))
      place()
      const observer = new ResizeObserver(place)
      if (listRef.current) observer.observe(listRef.current)
      return () => observer.disconnect()
    }, [activeIndex, tabs])

    useLayoutEffect(() => {
      if (activeBox && !placed) requestAnimationFrame(() => setPlaced(true))
    }, [activeBox, placed])

    const select = (index: number) => {
      const tab = tabs[index]
      if (!tab) return
      setOwnActive(tab.id)
      onTabChange?.(tab.id)
    }

    const onKeyDown = (event: React.KeyboardEvent) => {
      const last = tabs.length - 1
      const next =
        event.key === "ArrowRight" ? (activeIndex === last ? 0 : activeIndex + 1)
        : event.key === "ArrowLeft" ? (activeIndex === 0 ? last : activeIndex - 1)
        : event.key === "Home" ? 0
        : event.key === "End" ? last
        : null
      if (next === null) return
      event.preventDefault()
      select(next)
      tabRefs.current[next]?.focus()
    }

    return (
      <div
        ref={ref}
        className={cn("relative overflow-x-auto [scrollbar-width:none]", className)}
        {...props}
      >
        <div ref={listRef} className={cn("relative min-w-max border-b py-1", listClassName)}>
          {/* Hover Highlight */}
          <div
            className={cn(
              "absolute top-1 left-0 h-7 rounded-md bg-accent ease-[cubic-bezier(0.22,1,0.36,1)]",
              placed && "transition-[transform,width,opacity] duration-250 motion-reduce:transition-none",
            )}
            style={{
              transform: `translateX(${hoverBox?.left ?? 0}px)`,
              width: hoverBox?.width ?? 0,
              opacity: hoveredIndex !== null ? 1 : 0,
            }}
          />

          {/* Active Indicator */}
          <div
            className={cn(
              "absolute -bottom-px left-0 h-0.5 bg-primary ease-[cubic-bezier(0.22,1,0.36,1)]",
              placed && "transition-[transform,width] duration-250 motion-reduce:transition-none",
            )}
            style={{ transform: `translateX(${activeBox?.left ?? 0}px)`, width: activeBox?.width ?? 0 }}
          />

          {/* Tabs */}
          <div
            role="tablist"
            aria-label={ariaLabel}
            className="relative flex items-center gap-1.5"
            onKeyDown={onKeyDown}
          >
            {tabs.map((tab, index) => {
              const selected = index === activeIndex
              return (
                <button
                  key={tab.id}
                  ref={(el) => {
                    tabRefs.current[index] = el
                  }}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  tabIndex={selected ? 0 : -1}
                  className={cn(
                    "flex h-7 cursor-pointer items-center justify-center rounded-md px-3 text-sm leading-5 font-medium whitespace-nowrap transition-colors duration-300 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    selected ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                  onMouseEnter={() => setHoveredIndex(index)}
                  onMouseLeave={() => setHoveredIndex(null)}
                  onClick={() => select(index)}
                >
                  {tab.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  }
)
Tabs.displayName = "Tabs"

export { Tabs, type Tab, type TabsProps }
