import { useRef, type ComponentProps } from "react";
import { X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

type Props = Omit<ComponentProps<"input">, "type" | "value" | "onChange" | "ref"> & {
  value: string;
  onValueChange: (value: string) => void;
  clearLabel?: string;
  wrapperClassName?: string;
};

export function SearchInput({ value, onValueChange, clearLabel = "Clear search", wrapperClassName, className, disabled, readOnly, ...props }: Props) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className={cn("relative min-w-0", wrapperClassName)}>
      <Input
        {...props}
        ref={input}
        type="search"
        value={value}
        disabled={disabled}
        readOnly={readOnly}
        onChange={(event) => onValueChange(event.target.value)}
        className={cn(className, "pr-8 [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none")}
      />
      {value.length > 0 && !disabled && !readOnly && (
        <button
          type="button"
          aria-label={clearLabel}
          title={clearLabel}
          className="absolute inset-y-0 right-0 flex w-7 items-center justify-center rounded-r-md text-muted-foreground outline-none hover:bg-accent/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            onValueChange("");
            input.current?.focus();
          }}
        >
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
