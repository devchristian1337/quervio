'use client';

import * as React from 'react';
import { Checkbox as CheckboxPrimitive } from 'radix-ui';
import { motion } from 'motion/react';

import { cn } from '@/lib/utils';

type CheckboxProps = React.ComponentPropsWithoutRef<
  typeof CheckboxPrimitive.Root
>;

// The border is the app's, as on its fields: --muted is also the hover fill
// of rows and toolbar labels, where a borderless box would disappear. The
// focus ring sits inside the border; on a checked box, where --ring is the
// fill itself, it turns to the check's colour.
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  CheckboxProps
>(({ className, ...props }, ref) => {
  const [isChecked, setIsChecked] = React.useState(
    props?.checked ?? props?.defaultChecked ?? false,
  );

  React.useEffect(() => {
    setIsChecked(props?.checked ?? props?.defaultChecked ?? false);
  }, [props?.checked, props?.defaultChecked]);

  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      {...props}
      onCheckedChange={(checked) => {
        setIsChecked(checked);
        props.onCheckedChange?.(checked);
      }}
      asChild
    >
      <motion.button
        className={cn(
          'peer size-5 flex items-center justify-center shrink-0 rounded-sm border border-input bg-muted transition-colors duration-500 outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground data-[state=checked]:focus-visible:ring-primary-foreground/70',
          className,
        )}
        ref={ref}
        whileTap={{ scale: 0.95 }}
        whileHover={{ scale: 1.05 }}
      >
        <CheckboxPrimitive.Indicator forceMount asChild>
          <motion.svg
            xmlns="http://www.w3.org/2000/svg"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="3.5"
            stroke="currentColor"
            className="size-3.5"
            initial="unchecked"
            animate={isChecked ? 'checked' : 'unchecked'}
          >
            <motion.path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M4.5 12.75l6 6 9-13.5"
              variants={{
                checked: {
                  pathLength: 1,
                  opacity: 1,
                  transition: {
                    duration: 0.2,
                    delay: 0.2,
                  },
                },
                unchecked: {
                  pathLength: 0,
                  opacity: 0,
                  transition: {
                    duration: 0.2,
                  },
                },
              }}
            />
          </motion.svg>
        </CheckboxPrimitive.Indicator>
      </motion.button>
    </CheckboxPrimitive.Root>
  );
});

Checkbox.displayName = 'Checkbox';

export { Checkbox, type CheckboxProps };
