// A slider whose thumb carries its value, animated by NumberFlow (after the
// Number Flow slider demo). Radix handles the keyboard, focus and screen
// readers; colours come from the theme, as on the switch, not the demo's
// zinc and black. Not used yet: it is here for the first setting that needs one.
//
//   const [value, setValue] = useState([50])
//   <Slider value={value} onValueChange={setValue} min={0} max={100} step={1} aria-label="Volume" />
import * as React from "react"
import NumberFlow, { continuous } from "@number-flow/react"
import { cn } from "cn"
import { Slider as SliderPrimitive } from "radix-ui"

// The spring-like curve the value settles on when it changes.
const SETTLE =
  "linear(0, 0.0033 0.8%, 0.0263 2.39%, 0.0896 4.77%, 0.4676 15.12%, 0.5688, 0.6553, 0.7274, 0.7862, 0.8336 31.04%, 0.8793, 0.9132 38.99%, 0.9421 43.77%, 0.9642 49.34%, 0.9796 55.71%, 0.9893 62.87%, 0.9952 71.62%, 0.9983 82.76%, 0.9996 99.47%)"

function Slider({ value, className, "aria-label": label, ...props }: React.ComponentProps<typeof SliderPrimitive.Root>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      value={value}
      className={cn(
        "relative flex h-5 w-[200px] touch-none items-center select-none data-[disabled]:opacity-50",
        className
      )}
      {...props}
    >
      <SliderPrimitive.Track data-slot="slider-track" className="relative h-[3px] grow rounded-full bg-muted">
        <SliderPrimitive.Range data-slot="slider-range" className="absolute h-full rounded-full bg-brand-secondary" />
      </SliderPrimitive.Track>
      <SliderPrimitive.Thumb
        data-slot="slider-thumb"
        aria-label={label}
        className="relative block size-5 rounded-full bg-white shadow-md ring ring-black/10 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {value?.[0] != null && (
          <NumberFlow
            willChange
            value={value[0]}
            isolate
            plugins={[continuous]}
            opacityTiming={{ duration: 250, easing: "ease-out" }}
            transformTiming={{ duration: 500, easing: SETTLE }}
            className="absolute bottom-8 left-1/2 -translate-x-1/2 text-lg font-semibold text-foreground"
          />
        )}
      </SliderPrimitive.Thumb>
    </SliderPrimitive.Root>
  )
}

export { Slider }
