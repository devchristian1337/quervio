import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), open: vi.fn(), modelText: vi.fn(),
  warning: vi.fn(), error: vi.fn(), success: vi.fn(),
  state: { tabs: [] as Record<string, unknown>[], activeId: null as string | null },
}));
vi.mock("@/lib/api", () => ({ api: { tabsLoad: mocks.load, tabsSave: mocks.save } }));
vi.mock("@/lib/editor", () => ({ modelText: mocks.modelText }));
vi.mock("@/components/ui/basic-toast", () => ({
  toast: { warning: mocks.warning, error: mocks.error, success: mocks.success },
}));
vi.mock("@/stores/connections", () => ({
  useConnections: { getState: () => ({ connections: [{ id: "known" }] }) },
}));
vi.mock("@/stores/queries", () => ({
  useQueries: { getState: () => ({ ...mocks.state, open: mocks.open }), subscribe: vi.fn() },
}));

const savedTab = (connectionId = "known") => ({
  title: "Query 1", connectionId, database: "master", filePath: null,
  dirty: true, text: "SELECT N'unsaved';",
});
const loaded = (tabs = [savedTab()], recovered = false) => ({
  snapshot: JSON.stringify({ tabs, active: 0 }), recovered,
});

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal("window", globalThis);
  mocks.load.mockResolvedValue({ snapshot: null, recovered: false });
  mocks.save.mockResolvedValue(undefined);
  mocks.open.mockResolvedValue(undefined);
  mocks.state = { tabs: [], activeId: null };
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("query tab recovery", () => {
  it("reports a failed save once and lets the next successful save recover", async () => {
    const session = await import("./session-restore");
    await session.restoreTabs();
    mocks.save.mockRejectedValue(new Error("disk full"));
    expect(await session.saveNow()).toBe(false);
    expect(await session.saveNow()).toBe(false);
    expect(mocks.warning).toHaveBeenCalledTimes(1);
    mocks.save.mockResolvedValue(undefined);
    expect(await session.saveNow()).toBe(true);
    expect(mocks.success).toHaveBeenCalledTimes(1);
  });

  it("serializes saves so a slow older write cannot replace newer SQL", async () => {
    const session = await import("./session-restore");
    await session.restoreTabs();
    let finish!: () => void;
    mocks.save.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const first = session.saveNow();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    mocks.state = { tabs: [{ ...savedTab(), id: "q", initialText: "SELECT 2;" }], activeId: "q" };
    const second = session.saveNow();
    await Promise.resolve();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    expect(JSON.parse(mocks.save.mock.calls[1][0]).tabs[0].text).toBe("SELECT 2;");
  });

  it("keeps unsaved SQL even when its Saved Connection was removed", async () => {
    mocks.load.mockResolvedValue(loaded([savedTab("removed")]));
    const session = await import("./session-restore");
    await session.restoreTabs();
    expect(mocks.open).toHaveBeenCalledWith("removed", "master", expect.objectContaining({
      text: "SELECT N'unsaved';", dirty: true, activate: true,
    }));
    expect(mocks.warning).toHaveBeenCalled();
  });

  it("announces restoration from the previous snapshot", async () => {
    mocks.load.mockResolvedValue(loaded([savedTab()], true));
    const session = await import("./session-restore");
    await session.restoreTabs();
    expect(mocks.open).toHaveBeenCalledTimes(1);
    expect(mocks.warning).toHaveBeenCalledWith("Query tabs recovered", expect.anything());
  });

  it("preserves unreadable snapshots instead of overwriting them with empty tabs", async () => {
    mocks.load.mockRejectedValue(new Error("unreadable snapshots"));
    const session = await import("./session-restore");
    await session.restoreTabs();
    expect(await session.saveNow()).toBe(false);
    expect(mocks.save).not.toHaveBeenCalled();
    expect(mocks.warning).toHaveBeenCalled();
  });

  it("waits for the restored tabs before saving a new snapshot", async () => {
    mocks.load.mockResolvedValue(loaded());
    let finishLoad!: (value: unknown) => void;
    mocks.load.mockImplementationOnce(() => new Promise((resolve) => { finishLoad = resolve; }));
    const session = await import("./session-restore");
    const restore = session.restoreTabs();
    const save = session.saveNow();
    await Promise.resolve();
    expect(mocks.save).not.toHaveBeenCalled();
    finishLoad(loaded());
    await restore;
    expect(await save).toBe(true);
  });

  it("saves and closes without waiting for restored tabs to connect", async () => {
    mocks.load.mockResolvedValue(loaded());
    // Like the store: the tab is added at once, then its Session never opens.
    mocks.open.mockImplementation((connectionId: string, database: string, options: { text: string }) => {
      mocks.state = { tabs: [{ ...savedTab(connectionId), database, id: "q", initialText: options.text }], activeId: "q" };
      return new Promise<void>(() => {});
    });
    const session = await import("./session-restore");
    await session.restoreTabs();
    expect(await session.saveNow()).toBe(true);
    expect(JSON.parse(mocks.save.mock.calls[0][0]).tabs[0].text).toBe("SELECT N'unsaved';");
  });
});
