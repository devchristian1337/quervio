"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

// Coloured like the app's menus and dropdowns (popover, border, shadow), so
// it follows the theme; the arrow's border carries the outline round it.
// Radix marks the content with data-state (delayed-open, instant-open,
// closed), not data-open/data-closed, so the animations key on that.
function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-50 inline-flex w-fit max-w-xs origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 rounded-md border bg-popover px-3 py-1.5 text-xs text-popover-foreground shadow-md has-data-[slot=kbd]:pr-1.5 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 **:data-[slot=kbd]:relative **:data-[slot=kbd]:isolate **:data-[slot=kbd]:z-50 **:data-[slot=kbd]:rounded-sm ease-[ease-out] data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:zoom-in-98 data-[state=instant-open]:animate-in data-[state=instant-open]:fade-in-0 data-[state=instant-open]:zoom-in-98 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-98 motion-reduce:animate-none!",
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px] border-r border-b bg-popover fill-popover" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

// The app's shorthand: wraps one element and shows `label` over it. With no
// label it never opens; the tree stays the same so the element keeps its
// state when a label comes and goes. A disabled button gets no pointer events,
// so one that can be disabled passes `wrap` and the tip hovers a wrapper.
function Tip({
  label,
  side,
  wrap,
  children,
}: {
  label: React.ReactNode
  side?: React.ComponentProps<typeof TooltipPrimitive.Content>["side"]
  wrap?: boolean
  children: React.ReactElement
}) {
  const empty = label === undefined || label === null || label === ""
  return (
    <Tooltip open={empty ? false : undefined}>
      <TooltipTrigger asChild>
        {wrap ? <span className="inline-flex">{children}</span> : children}
      </TooltipTrigger>
      {!empty && (
        <TooltipContent side={side} sideOffset={4}>
          {label}
        </TooltipContent>
      )}
    </Tooltip>
  )
}

export { Tip, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger }

export default Tooltip
