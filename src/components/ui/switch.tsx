// The app's switch: Radix for the keyboard, focus and screen readers, with a
// thumb that slides on a spring (after the Framer Motion switch). The track
// takes the theme's second brand colour when on.
import * as React from "react"
import { motion, useReducedMotion } from "motion/react"
import { cn } from "cn"
import { Switch as SwitchPrimitive } from "radix-ui"

// Track 40×22 with 1px border and 2px padding; the thumb is 16px.
const THUMB = 16
const TRAVEL = 40 - 2 - 4 - THUMB

function Switch({ className, checked, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  const still = useReducedMotion()
  const on = checked ?? false
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      checked={checked}
      className={cn(
        "peer relative inline-flex h-[22px] w-10 shrink-0 items-center rounded-full border px-0.5 shadow-[inset_0_0_8px_rgb(0_0_0/0.25)] transition duration-200 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50",
        "data-[state=checked]:border-transparent data-[state=checked]:bg-brand-secondary data-[state=unchecked]:border-border data-[state=unchecked]:bg-muted-foreground/25",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb asChild>
        <motion.span
          data-slot="switch-thumb"
          initial={false}
          animate={{ x: on ? TRAVEL : 0 }}
          // Starts at once and settles without bouncing.
          transition={still ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 45 }}
          className="pointer-events-none z-10 block size-4 rounded-full bg-white shadow-md data-[state=checked]:bg-background"
        />
      </SwitchPrimitive.Thumb>
    </SwitchPrimitive.Root>
  )
}

export { Switch }
