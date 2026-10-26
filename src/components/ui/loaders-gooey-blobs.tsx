import * as React from "react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

export interface LoaderGooeyBlobsProps extends Omit<React.ComponentProps<"div">, "children"> {
  /** Diameter of each blob, in pixels. */
  size?: number;
  color?: string;
  /** Seconds for one back-and-forth. */
  duration?: number;
}

/** Three blobs that merge as they move, for something still running. */
export function LoaderGooeyBlobs({
  className,
  size = 20,
  color = "currentColor",
  duration = 1.5,
  ...props
}: LoaderGooeyBlobsProps) {
  // One filter per loader: several can be on screen, and ids must be
  // unique. useId's characters are not valid in url(#…), so keep [\w-].
  const filterId = `gooey-${React.useId().replace(/[^\w-]/g, "")}`;
  // Windows "Animation effects" off: still blobs, no movement.
  const still = useReducedMotion();

  return (
    <div role="status" className={cn("flex items-center gap-2", className)} {...props}>
      <svg width="0" height="0" aria-hidden>
        <defs>
          <filter id={filterId}>
            <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7"
              result="gooey"
            />
            <feBlend in="SourceGraphic" in2="gooey" />
          </filter>
        </defs>
      </svg>
      <div style={{ filter: `url(#${filterId})` }} className="flex gap-1">
        {[0, 1, 2].map((index) => (
          <motion.div
            key={index}
            className="rounded-full"
            style={{ width: size, height: size, backgroundColor: color }}
            animate={still ? undefined : { x: [0, 15, 0, -15, 0], scale: [1, 1.2, 1, 1.2, 1] }}
            transition={{ duration, ease: "easeInOut", repeat: Infinity, delay: index * 0.2 }}
          />
        ))}
      </div>
    </div>
  );
}

export default LoaderGooeyBlobs;
