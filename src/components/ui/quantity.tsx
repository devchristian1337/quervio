// A stepper: minus and plus buttons that spring under the pointer, around a
// value that slides in as it changes (after the Quantity component). Built on
// the app's Button; the value animation is skipped under reduced motion.
import * as React from "react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { MinusIcon, PlusIcon } from "lucide-react"
import { cn } from "cn"
import { Button } from "@/components/ui/button"

const MotionButton = motion.create(Button)

const buttonSpring = { type: "spring", stiffness: 400, damping: 17 } as const

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
  const isDisabled = disabled || (max !== undefined && value !== undefined && value >= max)
  return (
    <MotionButton
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Increase"
      className={cn("cursor-pointer disabled:cursor-not-allowed disabled:opacity-50", className)}
      disabled={isDisabled}
      whileHover={isDisabled ? undefined : { scale: 1.05 }}
      whileTap={isDisabled ? undefined : { scale: 0.95 }}
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
  const isDisabled = disabled || (value !== undefined && value <= min)
  return (
    <MotionButton
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Decrease"
      className={cn("cursor-pointer disabled:cursor-not-allowed disabled:opacity-50", className)}
      disabled={isDisabled}
      whileHover={isDisabled ? undefined : { scale: 1.05 }}
      whileTap={isDisabled ? undefined : { scale: 0.95 }}
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
          initial={still ? false : { y: 6, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={still ? undefined : { y: -6, opacity: 0 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </div>
  )
}
