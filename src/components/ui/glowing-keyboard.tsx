// A keyboard that lights the keys of a shortcut (Settings › Shortcuts).
// After Legion's GlowingKeyboard, redrawn as a Windows keyboard in the
// theme's colours. Keys are named as src/lib/commands.ts writes them:
// "Ctrl", "Shift", "Alt", "F5", "S", "Tab", ",", so a shortcut split on "+"
// is what lights up. Both Ctrl, Shift and Alt keys light, since either works.
import { memo, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

interface KeyDef {
  id: string;
  label?: ReactNode;
  /** Share of the row's free width this key takes; fixed-width when unset. */
  grow?: number;
  align?: "start" | "end";
}

const letters = (keys: string) => [...keys].map((id): KeyDef => ({ id }));
const icon = 12;

const ROWS: (KeyDef | "arrows")[][] = [
  [
    { id: "Esc", grow: 0.6, align: "start" },
    ...Array.from({ length: 12 }, (_, i): KeyDef => ({ id: `F${i + 1}` })),
    { id: "Pause", grow: 0.4, align: "end" },
  ],
  [...letters("`1234567890-="), { id: "Backspace", grow: 1, align: "end" }],
  [{ id: "Tab", grow: 1, align: "start" }, ...letters("QWERTYUIOP[]\\")],
  [{ id: "CapsLock", label: "Caps", grow: 1, align: "start" }, ...letters("ASDFGHJKL;'"), { id: "Enter", grow: 1, align: "end" }],
  [{ id: "Shift", grow: 1, align: "start" }, ...letters("ZXCVBNM,./"), { id: "Shift", grow: 1, align: "end" }],
  [
    { id: "Ctrl", grow: 0.5, align: "start" },
    { id: "Win" },
    { id: "Alt", grow: 0.3 },
    { id: "Space", label: "", grow: 5 },
    { id: "AltGr", label: "Alt Gr", grow: 0.3 },
    { id: "Ctrl", grow: 0.5, align: "end" },
    "arrows",
  ],
];

interface GlowingKeyboardProps {
  /** The keys to light, as in a shortcut: ["Ctrl", "Shift", "S"]. */
  highlight: string[];
  /** Width and height of a plain key, in pixels. */
  keySize?: number;
  className?: string;
}

export const GlowingKeyboard = memo(({ highlight, keySize = 34, className }: GlowingKeyboardProps) => {
  const still = useReducedMotion() ?? false;
  const lit = new Set(highlight);
  return (
    <div className={cn("flex w-full flex-col gap-1.5 rounded-lg border bg-muted/30 p-2", className)} aria-hidden>
      {ROWS.map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-1.5">
          {row.map((key, index) => {
            // Keys light up row by row when the keyboard first shows.
            const delay = index * 0.03 + rowIndex * 0.06;
            if (key === "arrows") return <ArrowKeys key="arrows" lit={lit} size={keySize} delay={delay} still={still} />;
            return <Key key={index} def={key} lit={lit.has(key.id)} size={keySize} delay={delay} still={still} />;
          })}
        </div>
      ))}
    </div>
  );
});
GlowingKeyboard.displayName = "GlowingKeyboard";

interface KeyProps {
  def: KeyDef;
  lit: boolean;
  size: number;
  delay: number;
  still: boolean;
  height?: number;
  className?: string;
}

function Key({ def, lit, size, delay, still, height = size, className }: KeyProps) {
  return (
    <motion.div
      initial={still ? false : { opacity: 0.3 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut", delay }}
      // Width only: the up and down arrows sit in a column, where flex would set their height.
      style={{ flex: def.grow ? `${def.grow} 1 ${size}px` : "none", width: def.grow ? undefined : size, height }}
      className={cn(
        "flex min-w-0 items-center justify-center rounded-md border border-t-[1.5px] bg-background/60 px-1.5 text-[11px] text-muted-foreground shadow-[inset_0_0_12px_rgb(0_0_0/0.12)] transition-colors duration-200 select-none",
        def.align === "start" && "justify-start",
        def.align === "end" && "justify-end",
        lit && "glowing-key text-primary",
        className,
      )}
    >
      <span className={cn("truncate", lit && "blur-in font-medium")}>{def.label ?? def.id}</span>
    </motion.div>
  );
}

function ArrowKeys({ lit, size, delay, still }: { lit: Set<string>; size: number; delay: number; still: boolean }) {
  const half = (size - 2) / 2;
  const arrow = (id: string, label: ReactNode, className?: string) => (
    <Key def={{ id, label }} lit={lit.has(id)} size={size} delay={delay} still={still} height={half} className={className} />
  );
  return (
    <div className="flex items-end gap-1.5">
      {arrow("Left", <ArrowLeft size={icon} />)}
      <div className="flex flex-col gap-0.5">
        {arrow("Up", <ArrowUp size={icon} />)}
        {arrow("Down", <ArrowDown size={icon} />)}
      </div>
      {arrow("Right", <ArrowRight size={icon} />)}
    </div>
  );
}
