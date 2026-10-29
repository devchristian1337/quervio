// A stepper: minus and plus buttons that spring under the pointer, around a
// value that slides in as it changes (after the Quantity component). Built on
// the app's Button; nothing moves under reduced motion.
import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { MinusIcon, PlusIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"

const MotionButton = motion.create(Button)

// Critically damped: the press is direct, with no bounce.
const buttonSpring = { type: "spring", stiffness: 400, damping: 40 } as const

type StepButtonProps = Omit<React.ComponentProps<typeof MotionButton>, "value">

export interface QuantityIncreaseProps extends StepButtonProps {
  max?: number
  value?: number
}

export function QuantityIncrease({
  children = <PlusIcon className="size-4" />,
  className,
  max,
  value,
  disabled,
  ...props
}: QuantityIncreaseProps) {
  const still = useReducedMotion() ?? false
  const isDisabled = disabled || (max !== undefined && value !== undefined && value >= max)
  return (
    <MotionButton
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Increase"
      className={cn("cursor-pointer disabled:cursor-not-allowed disabled:opacity-50", className)}
      disabled={isDisabled}
      whileHover={isDisabled || still ? undefined : { scale: 1.05 }}
      whileTap={isDisabled || still ? undefined : { scale: 0.95 }}
      transition={buttonSpring}
      {...props}
    >
      {children}
    </MotionButton>
  )
}

export interface QuantityDecreaseProps extends StepButtonProps {
  min?: number
  value?: number
}

export function QuantityDecrease({
  children = <MinusIcon className="size-4" />,
  className,
  min = 1,
  value,
  disabled,
  ...props
}: QuantityDecreaseProps) {
  const still = useReducedMotion() ?? false
  const isDisabled = disabled || (value !== undefined && value <= min)
  return (
    <MotionButton
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Decrease"
      className={cn("cursor-pointer disabled:cursor-not-allowed disabled:opacity-50", className)}
      disabled={isDisabled}
      whileHover={isDisabled || still ? undefined : { scale: 1.05 }}
      whileTap={isDisabled || still ? undefined : { scale: 0.95 }}
      transition={buttonSpring}
      {...props}
    >
      {children}
    </MotionButton>
  )
}

export function QuantityValue({ className, children, ...props }: React.ComponentProps<"div">) {
  const still = useReducedMotion() ?? false
  return (
    <div
      className={cn("relative flex items-center justify-center overflow-hidden px-2 tabular-nums", className)}
      {...props}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={String(children)}
          initial={still ? false : { y: 4, opacity: 0, filter: "blur(2px)" }}
          animate={{ y: 0, opacity: 1, filter: "blur(0px)" }}
          exit={still ? undefined : { y: -4, opacity: 0, filter: "blur(2px)" }}
          transition={{ duration: 0.15, ease: "easeInOut" }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
