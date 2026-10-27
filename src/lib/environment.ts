import type { Environment } from "@/lib/api";

/**
 * How each Environment looks wherever a Saved Connection appears. Red, amber
 * and green belong to the Environments alone: no button or message uses them,
 * so a colour on screen always says which server a query goes to. Each place
 * shows one coloured mark: the dot in the Object Explorer and the Connect
 * dialog, the pill in the query toolbar.
 */
export const ENVIRONMENTS: Record<Environment, { label: string; dot: string; pill: string }> = {
  production: {
    label: "Production",
    dot: "bg-red-500",
    pill: "bg-red-500/15 text-red-700 dark:text-red-300",
  },
  test: {
    label: "Test",
    dot: "bg-amber-500",
    pill: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  },
  development: {
    label: "Development",
    dot: "bg-emerald-500",
    pill: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  },
};
