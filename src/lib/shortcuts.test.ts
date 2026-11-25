import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/components/ui/basic-toast", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock("@/lib/editor", () => ({
  scriptForExecution: vi.fn(() => ({ text: "SELECT 1", baseLine: 0 })),
  findInEditor: vi.fn(),
  formatInEditor: vi.fn(),
  hasSelection: vi.fn(() => false),
  modelText: vi.fn(() => "SELECT 1"),
  disposeModel: vi.fn(),
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: {
    openQuery: vi.fn(async () => ({ serverName: "srv", version: "16.0", database: "master" })),
    closeQuery: vi.fn(async () => {}),
    executeQuery: vi.fn(async () => "succeeded"),
    fileWrite: vi.fn(async () => {}),
  },
}));

const { api } = await import("@/lib/api");
const { commandFor, shortcutOf } = await import("@/lib/commands");
const { runCommand } = await import("@/lib/shortcuts");
const { useQueries } = await import("@/stores/queries");
const { useCommandPalette } = await import("@/stores/dialogs");

function keyEvent(props: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    code: "",
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...props,
  } as KeyboardEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  useQueries.setState({ tabs: [], activeId: null });
  useCommandPalette.setState({ open: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("shortcutOf() layout and Meta key handling", () => {
  it("uses the layout key for letters and punctuation on AZERTY and Dvorak", () => {
    const azertyUndo = keyEvent({ ctrlKey: true, key: "z", code: "KeyW" });
    expect(shortcutOf(azertyUndo)).toBe("Ctrl+Z");
    expect(commandFor("Ctrl+Z")).toBeNull();

    const azertyClose = keyEvent({ ctrlKey: true, key: "w", code: "KeyZ" });
    expect(shortcutOf(azertyClose)).toBe("Ctrl+W");
    expect(commandFor("Ctrl+W")).toBe("closeTab");

    const dvorakDot = keyEvent({ ctrlKey: true, key: ".", code: "KeyE" });
    expect(shortcutOf(dvorakDot)).toBe("Ctrl+.");
    expect(commandFor("Ctrl+.")).toBeNull();

    const shiftDigit = keyEvent({ shiftKey: true, key: "!", code: "Digit1" });
    expect(shortcutOf(shiftDigit)).toBe("Shift+1");
  });

  it("includes Meta so Meta+F5 and Ctrl+Meta+W do not trigger F5 or Ctrl+W", () => {
    expect(shortcutOf(keyEvent({ metaKey: true, key: "F5", code: "F5" }))).toBe("Meta+F5");
    expect(commandFor("Meta+F5")).toBeNull();
    expect(shortcutOf(keyEvent({ ctrlKey: true, metaKey: true, key: "w", code: "KeyW" }))).toBe("Ctrl+Meta+W");
    expect(commandFor("Ctrl+Meta+W")).toBeNull();
  });
});

describe("runCommand() modal isolation", () => {
  it("blocks closeTab, save, newQuery and execute while a modal dialog is open", async () => {
    vi.stubGlobal("document", {
      querySelector: (selector: string) => (selector === '[role="dialog"]' ? {} : null),
    });

    await useQueries.getState().open("c1", "master", { text: "SELECT 1", filePath: "C:/a.sql", dirty: false });
    expect(useQueries.getState().tabs).toHaveLength(1);

    runCommand("execute");
    runCommand("closeTab");
    runCommand("save");
    runCommand("newQuery");
    await Promise.resolve();

    expect(api.executeQuery).not.toHaveBeenCalled();
    expect(api.closeQuery).not.toHaveBeenCalled();
    expect(api.fileWrite).not.toHaveBeenCalled();
    expect(useQueries.getState().tabs).toHaveLength(1);
  });
});
