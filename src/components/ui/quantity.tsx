// A stepper: minus and plus buttons that spring under the pointer, around a
// value whose changed digits slide in (after the Quantity component). Built on
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

// A digit rises in as the value goes up and drops in as it goes down;
// `custom` is the direction, 1 or -1.
const digit = {
  enter: (direction: number) => ({ y: 4 * direction, opacity: 0, filter: "blur(2px)" }),
  center: { y: 0, opacity: 1, filter: "blur(0px)" },
  exit: (direction: number) => ({ y: -4 * direction, opacity: 0, filter: "blur(2px)" }),
}

export function QuantityValue({ className, children, ...props }: React.ComponentProps<"div">) {
  const still = useReducedMotion() ?? false
  const text = String(children)
  const previous = React.useRef(text)
  const direction = React.useRef(1)
  if (previous.current !== text) {
    direction.current = Number(text) < Number(previous.current) ? -1 : 1
    previous.current = text
  }
  // Slots added after the first render (9 to 10) animate in; the first render does not.
  const mounted = React.useRef(false)
  React.useEffect(() => {
    mounted.current = true
  }, [])
  const characters = [...text]

  return (
    <div
      className={cn("relative flex items-center justify-center overflow-hidden px-2 tabular-nums", className)}
      {...props}
    >
      {still
        ? text
        : characters.map((character, index) => (
            // Keyed from the right, so 15 to 16 keeps the 1 and swaps only the 5 for the 6.
            <span key={characters.length - index} className="inline-grid">
              <AnimatePresence initial={mounted.current} custom={direction.current}>
                <motion.span
                  key={character}
                  custom={direction.current}
                  variants={digit}
                  initial="enter"
                  animate="center"
                  exit="exit"
                  transition={{ duration: 0.15, ease: "easeInOut" }}
                  style={{ gridArea: "1 / 1" }}
                >
                  {character}
                </motion.span>
              </AnimatePresence>
            </span>
          ))}
    </div>
  )
}
