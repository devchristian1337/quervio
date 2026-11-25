import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThemeId } from "@/lib/themes";

const setTheme = vi.fn(async () => {});
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ setTheme }),
}));

const { applyWindowTheme } = await import("@/lib/window-theme");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("applyWindowTheme", () => {
  it("hands removed or unknown theme ids back to system mode instead of forcing light", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { metadata: {} } });

    applyWindowTheme("system");
    expect(setTheme).toHaveBeenLastCalledWith(null);

    applyWindowTheme("removed-theme-id" as ThemeId);
    expect(setTheme).toHaveBeenLastCalledWith(null);

    applyWindowTheme("dracula");
    expect(setTheme).toHaveBeenLastCalledWith("dark");

    applyWindowTheme("light");
    expect(setTheme).toHaveBeenLastCalledWith("light");
  });
});
