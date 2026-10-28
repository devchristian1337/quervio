// A copy button whose icon turns into a check for a moment (after
// Origin UI's copy button). It is the app's Button and Tip, so focus ring,
// sizes and tooltip stay those of every other control. The check is the
// brand's colour, as on a success toast: green belongs to the Environments.
// The button stays enabled while it shows the check, so keyboard focus is
// not lost; a second press just copies again.
import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { isTauri } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/flexnative-tooltip";
import { toast } from "@/components/ui/basic-toast";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

type CopyButtonProps = Omit<ComponentProps<typeof Button>, "onClick" | "children"> & {
  // What goes on the clipboard; a function is read at the click.
  text: string | (() => string);
  // The tooltip and, for an icon-only button, its accessible name.
  label: string;
  // A visible label beside the icon, such as "Copy".
  children?: ReactNode;
};

export function CopyButton({ text, label, children, variant = "ghost", size, className, disabled, ...props }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    const value = typeof text === "function" ? text() : text;
    try {
      if (isTauri()) await writeText(value);
      else await navigator.clipboard.writeText(value);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch (error) {
      toast.error("Copy failed", { description: errorMessage(error) });
    }
  };

  return (
    <Tip label={copied ? "Copied" : label} wrap>
      <Button
        variant={variant}
        size={size ?? (children ? "sm" : "icon")}
        className={className}
        disabled={disabled}
        aria-label={children ? undefined : label}
        onClick={() => void copy()}
        {...props}
      >
        <span className="grid size-4 place-items-center" aria-hidden="true">
          <Check
            className={cn(
              "col-start-1 row-start-1 size-4 text-primary transition-all",
              copied ? "scale-100 opacity-100" : "scale-0 opacity-0",
            )}
          />
          <Copy
            className={cn(
              "col-start-1 row-start-1 size-4 transition-all",
              copied ? "scale-0 opacity-0" : "scale-100 opacity-100",
            )}
          />
        </span>
        {children}
        <span role="status" className="sr-only">
          {copied ? "Copied" : ""}
        </span>
      </Button>
    </Tip>
  );
}
