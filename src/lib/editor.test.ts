import { afterEach, describe, expect, it, vi } from "vitest";

const tauriWriteText = vi.fn(async () => {});
const tauriReadText = vi.fn(async () => "");

vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: tauriWriteText,
  readText: tauriReadText,
}));

const { copySelection, cutSelection, registerEditor } = await import("@/lib/editor");

afterEach(() => {
  registerEditor(null);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("editor clipboard helpers", () => {
  it("uses navigator.clipboard.writeText outside Tauri instead of invoking the Tauri plugin", async () => {
    const browserWriteText = vi.fn(async () => {});
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText: browserWriteText } });

    const model = { getValueInRange: () => "SELECT 1;" };
    const editor = {
      getSelection: () => ({ isEmpty: () => false }),
      getModel: () => model,
    };
    registerEditor(editor as never);

    await copySelection();
    expect(browserWriteText).toHaveBeenCalledWith("SELECT 1;");
    expect(tauriWriteText).not.toHaveBeenCalled();
  });

  it("does not edit a different model if the active editor model switches during async cut", async () => {
    let finishCopy!: () => void;
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(() => new Promise<void>((r) => { finishCopy = r; })) },
    });

    const modelA = { getValueInRange: () => "SELECT 1;" };
    const modelB = { getValueInRange: () => "SELECT 2;" };
    let activeModel = modelA;
    const executeEdits = vi.fn();
    const editor = {
      getSelection: () => ({ isEmpty: () => false }),
      getModel: () => activeModel,
      executeEdits,
      pushUndoStop: vi.fn(),
      focus: vi.fn(),
    };
    registerEditor(editor as never);

    const cutting = cutSelection();
    activeModel = modelB;
    finishCopy();
    await cutting;

    expect(executeEdits).not.toHaveBeenCalled();
  });
});
