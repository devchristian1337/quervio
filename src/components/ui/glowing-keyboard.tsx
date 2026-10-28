// A keyboard that lights the keys of a shortcut (Settings › Shortcuts).
// After Legion's GlowingKeyboard, redrawn as a Windows keyboard in the
// theme's colours. Keys are named as src/lib/commands.ts writes them:
// "Ctrl", "Shift", "Alt", "F5", "S", "Tab", ",", so a shortcut split on "+"
// is what lights up. A modifier lights on the left only, as it is written
// once in the shortcut: the right Shift and Ctrl have names of their own.
//
// The keys follow the layout Windows is typing with: navigator.keyboard
// gives the character of each physical key, which labels it, and a layout
// with the extra key beside Left Shift draws the European (ISO) shape, with
// the tall Enter. Without that API the keyboard is the US one.
import { memo, useEffect, useState, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { cn } from "@/lib/utils";

/** The character of each physical key in the active layout (KeyboardLayoutMap). */
interface LayoutMap {
  get(code: string): string | undefined;
}

interface KeyDef {
  id: string;
  /** The physical key (KeyboardEvent.code) of a key that types a character. */
  code?: string;
  label?: ReactNode;
  /** Share of the row's free width this key takes; fixed-width when unset. */
  grow?: number;
  align?: "start" | "end";
  /** The halves of the ISO Enter, drawn as one key over two rows. */
  part?: "top" | "bottom";
}

/** What each character key types on a US layout: the labels without the API. */
const US: Record<string, string> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  IntlBackslash: "\\",
};

const codes = (list: string[]) => list.map((code): KeyDef => ({ id: code, code }));
const letters = (keys: string) => [...keys].map((key) => `Key${key}`);
const digits = [..."1234567890"].map((digit) => `Digit${digit}`);
const icon = 12;
/** The gap between rows (gap-1.5), which the ISO Enter bridges. */
const ROW_GAP = 6;

/** The layout's character for a key, when it is one plain character (not a dead key's name). */
function typed(code: string, layout: LayoutMap | null) {
  const char = layout?.get(code);
  return char && [...char].length === 1 ? char : US[code];
}

/**
 * The name src/lib/commands.ts records for a key: letters and digits by their
 * place on a US keyboard, as shortcutOf reads them, other keys by what they type.
 */
function nameOf(code: string, layout: LayoutMap | null) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return (typed(code, layout) ?? code).toUpperCase();
}

/** What the key's cap says in this layout. */
function labelOf(code: string, layout: LayoutMap | null) {
  if (/^Key[A-Z]$/.test(code)) return (typed(code, layout) ?? code.slice(3)).toUpperCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return typed(code, layout) ?? code;
}

/** Whether the layout has the key between Left Shift and Z, a key of its own. */
function isIso(layout: LayoutMap | null) {
  const extra = layout?.get("IntlBackslash");
  // The US layout gives that key the backslash too: then it is not drawn.
  return !!extra && extra !== layout?.get("Backslash");
}

function rows(iso: boolean): (KeyDef | "arrows")[][] {
  return [
    [
      { id: "Esc", grow: 0.6, align: "start" },
      ...Array.from({ length: 12 }, (_, i): KeyDef => ({ id: `F${i + 1}` })),
      { id: "Pause", grow: 0.4, align: "end" },
    ],
    [...codes(["Backquote", ...digits, "Minus", "Equal"]), { id: "Backspace", grow: 1, align: "end" }],
    iso
      ? [
          { id: "Tab", grow: 1.5, align: "start" },
          ...codes([...letters("QWERTYUIOP"), "BracketLeft", "BracketRight"]),
          { id: "Enter", grow: 1.5, align: "end", part: "top" },
        ]
      : [{ id: "Tab", grow: 1, align: "start" }, ...codes([...letters("QWERTYUIOP"), "BracketLeft", "BracketRight", "Backslash"])],
    iso
      ? [
          { id: "CapsLock", label: "Caps", grow: 1.75, align: "start" },
          ...codes([...letters("ASDFGHJKL"), "Semicolon", "Quote", "Backslash"]),
          { id: "Enter", label: "", grow: 1.25, part: "bottom" },
        ]
      : [
          { id: "CapsLock", label: "Caps", grow: 1, align: "start" },
          ...codes([...letters("ASDFGHJKL"), "Semicolon", "Quote"]),
          { id: "Enter", grow: 1, align: "end" },
        ],
    iso
      ? [
          { id: "Shift", grow: 0.45, align: "start" },
          ...codes(["IntlBackslash", ...letters("ZXCVBNM"), "Comma", "Period", "Slash"]),
          { id: "ShiftRight", label: "Shift", grow: 1.55, align: "end" },
        ]
      : [
          { id: "Shift", grow: 1, align: "start" },
          ...codes([...letters("ZXCVBNM"), "Comma", "Period", "Slash"]),
          { id: "ShiftRight", label: "Shift", grow: 1, align: "end" },
        ],
    [
      { id: "Ctrl", grow: 0.5, align: "start" },
      { id: "Win" },
      { id: "Alt", grow: 0.3 },
      { id: "Space", label: "", grow: 5 },
      { id: "AltGr", label: "Alt Gr", grow: 0.3 },
      { id: "CtrlRight", label: "Ctrl", grow: 0.5, align: "end" },
      "arrows",
    ],
  ];
}

/** The active keyboard layout, read again when the window comes back (it may have changed). */
function useLayoutMap() {
  const [layout, setLayout] = useState<LayoutMap | null>(null);
  useEffect(() => {
    const keyboard = (navigator as { keyboard?: { getLayoutMap?: () => Promise<LayoutMap> } }).keyboard;
    if (!keyboard?.getLayoutMap) return;
    let live = true;
    const read = () =>
      keyboard.getLayoutMap!().then(
        (map) => live && setLayout(map),
        () => {},
      );
    void read();
    window.addEventListener("focus", read);
    return () => {
      live = false;
      window.removeEventListener("focus", read);
    };
  }, []);
  return layout;
}

interface GlowingKeyboardProps {
  /** The keys to light, as in a shortcut: ["Ctrl", "Shift", "S"]. */
  highlight: string[];
  /** Width and height of a plain key, in pixels. */
  keySize?: number;
  className?: string;
}

export const GlowingKeyboard = memo(({ highlight, keySize = 34, className }: GlowingKeyboardProps) => {
  const still = useReducedMotion() ?? false;
  const layout = useLayoutMap();
  const lit = new Set(highlight);
  return (
    <div className={cn("flex w-full flex-col gap-1.5 rounded-lg border bg-muted/30 p-2", className)} aria-hidden>
      {rows(isIso(layout)).map((row, rowIndex) => (
        <div key={rowIndex} className="flex gap-1.5">
          {row.map((key, index) => {
            // Keys light up row by row when the keyboard first shows.
            const delay = index * 0.03 + rowIndex * 0.06;
            if (key === "arrows") return <ArrowKeys key="arrows" lit={lit} size={keySize} delay={delay} still={still} />;
            const def = key.code ? { ...key, id: nameOf(key.code, layout), label: labelOf(key.code, layout) } : key;
            return <Key key={index} def={def} lit={lit.has(def.id)} size={keySize} delay={delay} still={still} />;
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
  // The top of the ISO Enter reaches down across the row gap to meet its bottom half.
  const top = def.part === "top";
  return (
    <motion.div
      initial={still ? false : { opacity: 0.3 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.5, ease: "easeOut", delay }}
      // Width only: the up and down arrows sit in a column, where flex would set their height.
      style={{
        flex: def.grow ? `${def.grow} 1 ${size}px` : "none",
        width: def.grow ? undefined : size,
        height: top ? height + ROW_GAP : height,
        marginBottom: top ? -ROW_GAP : undefined,
      }}
      className={cn(
        // Opaque, and above a lit key (z-1 against z-0), so a glow never tints the keys beside it.
        "relative z-1 flex min-w-0 items-center justify-center rounded-md border border-t-[1.5px] bg-background px-1.5 text-[11px] text-muted-foreground shadow-[inset_0_0_12px_rgb(0_0_0/0.12)] transition-[color,border-color,box-shadow] duration-200 ease-out select-none motion-reduce:transition-none",
        def.align === "start" && "justify-start",
        def.align === "end" && "justify-end",
        top && "items-start rounded-b-none! border-b-0! pt-2",
        def.part === "bottom" && "rounded-t-none! border-t-0!",
        lit && "glowing-key z-0 text-primary",
        className,
      )}
    >
      <span className={cn("truncate", lit && "font-medium")}>{def.label ?? def.id}</span>
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
