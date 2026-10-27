// Notifications, on Ark UI's toaster (after its basic and typed toast demos).
// They stack in the bottom-right corner and spread out on hover. Call them
// as the app always has: toast.success("Saved", { description: path }).
//
// Colours come from the theme, not the demo's tinted cards: red, amber and
// green belong to the Environments (src/lib/environment.ts), so only an
// error takes a colour, the theme's destructive red, on its icon.
import type { ReactNode } from "react";
import { Toast, Toaster as ArkToaster, createToaster } from "@ark-ui/react/toast";
import { Portal } from "@ark-ui/react/portal";
import { CircleCheck, Info, OctagonX, TriangleAlert, X } from "lucide-react";

export const toaster = createToaster({
  placement: "bottom-end",
  gap: 16,
  overlap: true,
  max: 5,
});

type ToastType = "success" | "error" | "warning" | "info";

const show = (type: ToastType) => (title: string, options: { description?: ReactNode } = {}) =>
  toaster.create({ title, description: options.description, type });

/** Shows a notification: toast.success, toast.error, toast.warning or toast.info. */
export const toast = {
  success: show("success"),
  error: show("error"),
  warning: show("warning"),
  info: show("info"),
};

const ICONS: Record<ToastType, { icon: typeof Info; className: string }> = {
  success: { icon: CircleCheck, className: "text-primary" },
  error: { icon: OctagonX, className: "text-destructive" },
  warning: { icon: TriangleAlert, className: "text-foreground" },
  info: { icon: Info, className: "text-muted-foreground" },
};

/** Renders the notifications; mounted once, in App. */
export function Toaster() {
  return (
    <Portal>
      <ArkToaster toaster={toaster}>
        {(toast) => {
          const { icon: Icon, className } = ICONS[(toast.type as ToastType) ?? "info"] ?? ICONS.info;
          return (
            <Toast.Root className="relative h-(--height) w-96 max-w-[calc(100vw-2rem)] translate-x-(--x) translate-y-(--y) scale-(--scale) rounded-lg border bg-popover p-4 pr-10 text-popover-foreground opacity-(--opacity) shadow-lg transition-all duration-300 will-change-transform wrap-anywhere z-(--z-index) motion-reduce:transition-none">
              <div className="flex items-start gap-3">
                <Icon className={`mt-0.5 size-4 shrink-0 ${className}`} />
                <div className="min-w-0 flex-1">
                  <Toast.Title className="text-sm font-medium">{toast.title}</Toast.Title>
                  {toast.description && (
                    <Toast.Description className="mt-1 text-sm text-muted-foreground select-text">
                      {toast.description}
                    </Toast.Description>
                  )}
                </div>
              </div>
              <Toast.CloseTrigger
                aria-label="Dismiss"
                className="absolute top-3 right-3 rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <X className="size-3" />
              </Toast.CloseTrigger>
            </Toast.Root>
          );
        }}
      </ArkToaster>
    </Portal>
  );
}
