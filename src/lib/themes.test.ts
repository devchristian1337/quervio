import { expect, it, vi } from "vitest";
import { editorThemeName, registerEditorThemes, THEMES } from "@/lib/themes";

it.each(THEMES)("keeps pinned SQL text and line numbers opaque in $name", (theme) => {
  const defineTheme = vi.fn();
  registerEditorThemes({ defineTheme });
  const definition = defineTheme.mock.calls.find(([name]) => name === editorThemeName(theme))![1];
  // The editor surface can show Mica, but pinned rows cover scrolling text.
  expect(definition.colors["editorStickyScroll.background"]).toBe(theme.palette.bg);
  expect(definition.colors["editorStickyScrollGutter.background"]).toBe(theme.palette.bg);
  expect(theme.palette.bg).toMatch(/^#[0-9a-f]{6}$/i);
});
