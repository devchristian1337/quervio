// Colour arithmetic for the canvas-drawn results grid, which cannot use CSS
// color-mix(). Takes #rgb, #rrggbb or #rrggbbaa.

function channels(hex: string): [number, number, number, number] {
  let value = hex.replace("#", "");
  if (value.length === 3) value = [...value].map((c) => c + c).join("");
  const n = (at: number) => parseInt(value.slice(at, at + 2), 16);
  return [n(0), n(2), n(4), value.length === 8 ? n(6) / 255 : 1];
}

/** `hex` at `alpha` opacity. */
export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b, a] = channels(hex);
  return `rgba(${r}, ${g}, ${b}, ${+(a * alpha).toFixed(3)})`;
}

/** `amount` (0–1) of `color` over an opaque `base`, as an opaque colour. */
export function mix(color: string, base: string, amount: number): string {
  const [r1, g1, b1, a1] = channels(color);
  const [r2, g2, b2] = channels(base);
  const t = amount * a1;
  const blend = (x: number, y: number) => Math.round(x * t + y * (1 - t));
  return `rgb(${blend(r1, r2)}, ${blend(g1, g2)}, ${blend(b1, b2)})`;
}
