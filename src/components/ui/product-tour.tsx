import * as React from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Dialog } from "radix-ui";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type TourPlacement = "top" | "bottom" | "left" | "right" | "auto" | "center";
export type TourStep = {
  target?: string;
  title: string;
  content: React.ReactNode;
  placement?: TourPlacement;
  padding?: number;
};
export type TourProps = {
  steps: TourStep[];
  open: boolean;
  onOpenChange?: (open: boolean) => void;
  index?: number;
  onIndexChange?: (index: number) => void;
  onFinish?: () => void;
  onSkip?: () => void;
  showProgress?: boolean;
  clickToNext?: boolean;
  className?: string;
};

type Rect = { top: number; left: number; width: number; height: number };
const SPRING = { type: "spring" as const, stiffness: 320, damping: 32, mass: 0.7 };

/** Spotlight and animated card from the supplied tour, using Quervio's theme and
 * Radix modal for focus trapping, background isolation and focus restoration. */
export function Tour({
  steps, open, onOpenChange, index: controlledIndex, onIndexChange,
  onFinish, onSkip, showProgress = true, clickToNext = false, className,
}: TourProps) {
  const reduce = useReducedMotion();
  const [indexState, setIndexState] = React.useState(0);
  const index = controlledIndex ?? indexState;
  const step = steps[index];
  const [card, setCard] = React.useState<HTMLDivElement | null>(null);
  const returnFocus = React.useRef<HTMLElement | null>(null);
  const [rect, setRect] = React.useState<Rect | null>(null);
  const [cardSize, setCardSize] = React.useState({ w: 340, h: 200 });
  const [vp, setVp] = React.useState({ w: window.innerWidth, h: window.innerHeight });
  const pad = step?.padding ?? 8;

  const setIndex = (value: number) => {
    setIndexState(value);
    onIndexChange?.(value);
  };
  const close = (completed: boolean) => {
    if (completed) onFinish?.();
    else onSkip?.();
    onOpenChange?.(false);
    setIndexState(0);
  };
  const next = () => index === steps.length - 1 ? close(true) : setIndex(index + 1);

  React.useLayoutEffect(() => {
    if (!open || !step) return;
    const target = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    const measure = () => {
      setVp({ w: window.innerWidth, h: window.innerHeight });
      const bounds = target?.getBoundingClientRect();
      setRect(bounds && bounds.width > 0 && bounds.height > 0
        ? { top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height }
        : null);
      if (card) {
        const size = card.getBoundingClientRect();
        // offset sizes are unaffected by the card's entrance scale animation.
        setCardSize({ w: card.offsetWidth || size.width, h: card.offsetHeight || size.height });
      }
    };
    target?.scrollIntoView({ behavior: "instant", block: "nearest", inline: "nearest" });
    measure();
    const observer = new ResizeObserver(measure);
    if (target) observer.observe(target);
    if (card) observer.observe(card);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open, step, card]);

  React.useEffect(() => {
    if (open) card?.querySelector<HTMLElement>("[data-tour-primary]")?.focus();
  }, [open, index, card]);

  if (!step) return null;
  const gap = 14 + pad;
  let place = step.placement ?? "auto";
  if (!rect) place = "center";
  if (place === "auto" && rect) {
    if (rect.top + rect.height + gap + cardSize.h < vp.h - 12) place = "bottom";
    else if (rect.top - gap - cardSize.h > 12) place = "top";
    else if (rect.left + rect.width + gap + cardSize.w < vp.w - 12) place = "right";
    else if (rect.left - gap - cardSize.w > 12) place = "left";
    else place = "center";
  }
  let left = (vp.w - cardSize.w) / 2;
  let top = (vp.h - cardSize.h) / 2;
  if (rect && place !== "center") {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    if (place === "bottom") { left = cx - cardSize.w / 2; top = rect.top + rect.height + gap; }
    if (place === "top") { left = cx - cardSize.w / 2; top = rect.top - gap - cardSize.h; }
    if (place === "right") { left = rect.left + rect.width + gap; top = cy - cardSize.h / 2; }
    if (place === "left") { left = rect.left - gap - cardSize.w; top = cy - cardSize.h / 2; }
  }
  left = Math.max(12, Math.min(left, vp.w - 12 - cardSize.w));
  top = Math.max(12, Math.min(top, vp.h - 12 - cardSize.h));

  return (
    <Dialog.Root open={open} onOpenChange={(value) => { if (!value) close(false); }}>
      <AnimatePresence>
        {open && (
          <Dialog.Portal forceMount>
            <Dialog.Content forceMount asChild
              onOpenAutoFocus={(event) => {
                event.preventDefault();
                returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                card?.querySelector<HTMLElement>("[data-tour-primary]")?.focus();
              }}
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                const previous = returnFocus.current;
                const fallback = document.querySelector<HTMLElement>('[data-tour="new-connection"]');
                (previous?.isConnected && previous !== document.body ? previous : fallback)?.focus({ preventScroll: true });
              }}
              onInteractOutside={(event) => event.preventDefault()}
            >
              <motion.div data-product-tour className={cn("fixed inset-0 z-[100] outline-none", className)}
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: reduce ? 0 : 0.2 }}
                onKeyDownCapture={(event) => {
                  // Global commands must never act on the workspace behind the tour.
                  if (event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/.test(event.key)) {
                    event.preventDefault(); event.stopPropagation(); return;
                  }
                  if (event.key === "ArrowRight") { event.preventDefault(); next(); }
                  if (event.key === "ArrowLeft") { event.preventDefault(); if (index > 0) setIndex(index - 1); }
                  // Enter activates the focused button, including Back and Close.
                }}
              >
                <div className="absolute inset-0" aria-hidden="true" onClick={() => { if (clickToNext) next(); }} />
                {rect ? (
                  <motion.div data-tour-spotlight aria-hidden="true"
                    className="pointer-events-none absolute rounded-xl outline outline-white/40"
                    initial={false}
                    animate={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }}
                    transition={reduce ? { duration: 0 } : SPRING}
                    style={{ boxShadow: "0 0 0 9999px rgba(4,4,6,0.6)" }}
                  />
                ) : <div className="pointer-events-none absolute inset-0 bg-black/60" aria-hidden="true" />}
                <motion.div ref={setCard} data-tour-card
                  className="absolute flex max-h-[calc(100dvh-24px)] w-[340px] max-w-[calc(100vw-24px)] flex-col overflow-y-auto rounded-2xl border bg-popover p-4 text-popover-foreground shadow-2xl"
                  initial={reduce ? false : { opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1, left, top }}
                  transition={reduce ? { duration: 0 } : SPRING}
                  style={{ left, top }}
                >
                  <div className="flex items-start justify-between gap-3">
                    <Dialog.Title className="text-sm leading-snug font-semibold">{step.title}</Dialog.Title>
                    <Button variant="ghost" size="icon" className="-mt-1 -mr-1 size-7 shrink-0 text-muted-foreground" aria-label="Close tour" onClick={() => close(false)}><X className="size-4" /></Button>
                  </div>
                  <Dialog.Description asChild>
                    <div className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{step.content}</div>
                  </Dialog.Description>
                  <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                    <div role="status" aria-live="polite" className="flex items-center gap-1.5">
                      <span className={showProgress ? "sr-only" : "text-xs text-muted-foreground"}>Step {index + 1} of {steps.length}</span>
                      {showProgress && steps.map((_, i) => <span key={i} aria-hidden="true" className={cn("h-1.5 rounded-full bg-muted-foreground/25 motion-safe:transition-all", i === index ? "w-4 bg-foreground" : "w-1.5")} />)}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {index > 0 && <Button variant="ghost" size="sm" onClick={() => setIndex(index - 1)}><ArrowLeft className="size-3.5" /> Back</Button>}
                      <Button size="sm" data-tour-primary onClick={next}>{index === steps.length - 1 ? "Done" : "Next"}{index < steps.length - 1 && <ArrowRight className="size-3.5" />}</Button>
                    </div>
                  </div>
                </motion.div>
              </motion.div>
            </Dialog.Content>
          </Dialog.Portal>
        )}
      </AnimatePresence>
    </Dialog.Root>
  );
}

export function useTour(storageKey?: string) {
  const [open, setOpen] = React.useState(false);
  const [index, setIndex] = React.useState(0);
  const seen = React.useCallback(() => {
    try { return !!storageKey && localStorage.getItem(storageKey) === "1"; }
    catch { return false; }
  }, [storageKey]);
  const start = React.useCallback(() => { setIndex(0); setOpen(true); }, []);
  const markSeen = React.useCallback(() => {
    try { if (storageKey) localStorage.setItem(storageKey, "1"); }
    catch { /* The tour still closes when browser storage is unavailable. */ }
  }, [storageKey]);
  return { open, setOpen, index, setIndex, start, seen, markSeen };
}
