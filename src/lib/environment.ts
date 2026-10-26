import type { Environment } from "@/lib/api";

/** How each Environment looks wherever a Saved Connection appears. */
export const ENVIRONMENTS: Record<
  Environment,
  { label: string; badge: string; dot: string; bar: string; text: string }
> = {
  production: {
    label: "Production",
    badge: "PROD",
    dot: "bg-red-500",
    bar: "border-l-red-500",
    text: "text-red-500",
  },
  test: {
    label: "Test",
    badge: "TEST",
    dot: "bg-amber-500",
    bar: "border-l-amber-500",
    text: "text-amber-500",
  },
  development: {
    label: "Development",
    badge: "DEV",
    dot: "bg-emerald-500",
    bar: "border-l-emerald-500",
    text: "text-emerald-500",
  },
};
