import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settingsLoad: vi.fn(),
  settingsSave: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: {
    settingsLoad: mocks.settingsLoad,
    settingsSave: mocks.settingsSave,
  },
}));
vi.mock("@/components/ui/basic-toast", () => ({
  toast: { error: mocks.toastError },
}));

const {
  DEFAULT_SETTINGS,
  executeOptions,
  flushSettings,
  loadSettings,
  normalizeSettings,
  useSettings,
} = await import("@/stores/settings");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.settingsSave.mockResolvedValue(undefined);
  useSettings.setState({ settings: structuredClone(DEFAULT_SETTINGS) });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("settings normalization and flushing", () => {
  it("normalizes and clamps floats, NaN and out-of-range numeric values on load and update", async () => {
    mocks.settingsLoad.mockResolvedValueOnce(
      JSON.stringify({
        version: 2,
        editor: { fontSize: 14.7, tabSize: 99 },
        query: { timeoutSeconds: 1.5, maxRows: 100.4, maxCellMB: 500 },
      }),
    );

    await loadSettings();
    expect(useSettings.getState().settings.editor).toMatchObject({ fontSize: 15, tabSize: 16 });
    expect(useSettings.getState().settings.query).toMatchObject({
      timeoutSeconds: 2,
      maxRows: 100,
      maxCellMB: 64,
    });
    expect(executeOptions()).toEqual({
      timeoutSeconds: 2,
      maxRows: 100,
      maxCellBytes: 64 * 1024 * 1024,
    });

    const normalized = normalizeSettings({
      ...DEFAULT_SETTINGS,
      query: { ...DEFAULT_SETTINGS.query, timeoutSeconds: Number.NaN, maxRows: -5, maxCellMB: 0 },
    });
    expect(normalized.query).toMatchObject({
      timeoutSeconds: DEFAULT_SETTINGS.query.timeoutSeconds,
      maxRows: 1,
      maxCellMB: 0.1,
    });
  });

  it("flushes debounced settings immediately via flushSettings()", async () => {
    vi.useFakeTimers();
    useSettings.getState().update("appearance", { theme: "dracula" });
    expect(mocks.settingsSave).not.toHaveBeenCalled();

    await flushSettings();
    expect(mocks.settingsSave).toHaveBeenCalledOnce();
    expect(JSON.parse(mocks.settingsSave.mock.calls[0][0]).appearance.theme).toBe("dracula");

    // Advancing past the old 300 ms debounce must not write a second time.
    vi.advanceTimersByTime(500);
    expect(mocks.settingsSave).toHaveBeenCalledTimes(1);
  });
});
