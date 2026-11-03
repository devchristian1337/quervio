import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { TextFieldMenu } from "@/components/TextFieldMenu";

const Command = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive>
>(({ className, ...props }, ref) => (
  <CommandPrimitive ref={ref} className={cn("flex h-full w-full flex-col overflow-hidden rounded-lg bg-popover text-popover-foreground", className)} {...props} />
));
Command.displayName = "Command";

function CommandDialog({ children, title = "Search commands", description = "Find an action, tool, open tab or saved connection.", onOpenAutoFocus, onCloseAutoFocus, ...props }: React.ComponentProps<typeof Dialog> & {
  title?: string;
  description?: string;
  onOpenAutoFocus?: React.ComponentProps<typeof DialogContent>["onOpenAutoFocus"];
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
}) {
  return (
    <Dialog {...props}>
      <DialogContent showCloseButton={false} className="gap-0 overflow-hidden p-0 sm:max-w-xl" onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>
        <Command label={title} loop vimBindings={false}>{children}</Command>
      </DialogContent>
    </Dialog>
  );
}

const CommandInput = React.forwardRef<
  React.ComponentRef<typeof CommandPrimitive.Input>,
  React.ComponentPropsWithoutRef<typeof CommandPrimitive.Input>
>(({ className, value, onValueChange, ...props }, ref) => {
  const input = React.useRef<HTMLInputElement>(null);
  React.useImperativeHandle(ref, () => input.current!, []);
  return (
    <div className="flex items-center gap-3 border-b px-4" cmdk-input-wrapper="">
      <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <TextFieldMenu>
        <CommandPrimitive.Input
          ref={input}
          value={value}
          onValueChange={onValueChange}
          className={cn("h-12 min-w-0 flex-1 bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-50", className)}
          {...props}
        />
      </TextFieldMenu>
      {value && onValueChange && (
        <button type="button" aria-label="Clear command search" title="Clear search" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring" onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} onMouseDown={(event) => event.preventDefault()} onClick={() => { onValueChange(""); input.current?.focus(); }}>
          <X className="size-3.5" aria-hidden="true" />
        </button>
      )}
      <kbd className="rounded border px-1 py-0.5 text-[10px] text-muted-foreground">Esc</kbd>
    </div>
  );
});
CommandInput.displayName = "CommandInput";

const CommandList = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.List>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.List>>(({ className, ...props }, ref) => (
  <CommandPrimitive.List ref={ref} className={cn("max-h-[min(24rem,60dvh)] overflow-x-hidden overflow-y-auto scroll-py-2", className)} {...props} />
));
CommandList.displayName = "CommandList";

const CommandEmpty = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.Empty>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>>(({ className, ...props }, ref) => (
  <CommandPrimitive.Empty ref={ref} className={cn("py-8 text-center text-sm text-muted-foreground", className)} {...props} />
));
CommandEmpty.displayName = "CommandEmpty";

const CommandGroup = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.Group>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Group>>(({ className, ...props }, ref) => (
  <CommandPrimitive.Group ref={ref} className={cn("overflow-hidden p-2 [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground", className)} {...props} />
));
CommandGroup.displayName = "CommandGroup";

const CommandSeparator = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.Separator>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>>(({ className, ...props }, ref) => (
  <CommandPrimitive.Separator ref={ref} className={cn("h-px bg-border", className)} {...props} />
));
CommandSeparator.displayName = "CommandSeparator";

const CommandItem = React.forwardRef<React.ComponentRef<typeof CommandPrimitive.Item>, React.ComponentPropsWithoutRef<typeof CommandPrimitive.Item>>(({ className, ...props }, ref) => (
  <CommandPrimitive.Item ref={ref} className={cn("relative flex cursor-pointer select-none items-center gap-3 rounded-md px-3 py-2 text-sm outline-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground", className)} {...props} />
));
CommandItem.displayName = "CommandItem";

function CommandShortcut({ className, ...props }: React.ComponentProps<"kbd">) {
  return <kbd className={cn("ml-auto shrink-0 rounded border border-border bg-background px-1 py-0.5 font-[inherit] text-[10px] text-muted-foreground", className)} {...props} />;
}

export { Command, CommandDialog, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandSeparator, CommandItem, CommandShortcut };
