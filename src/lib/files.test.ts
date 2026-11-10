import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class { onmessage = () => {}; } }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/components/ui/basic-toast", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/editor", () => ({ modelText: vi.fn(), disposeModel: vi.fn() }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: {
    openQuery: vi.fn(async () => ({ serverName: "test", version: "16.0", database: "master" })),
    closeQuery: vi.fn(async () => {}),
    endTransactions: vi.fn(async () => 0),
    fileWrite: vi.fn(async () => {}),
  },
}));

const { api } = await import("@/lib/api");
const { save } = await import("@tauri-apps/plugin-dialog");
const { modelText, disposeModel } = await import("@/lib/editor");
const { useQueries } = await import("@/stores/queries");
const { useDialogs } = await import("@/stores/dialogs");
const { closeTab, saveTab } = await import("@/lib/files");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const texts = new Map<string, string>();
const tab = (id: string) => useQueries.getState().tabs.find((item) => item.id === id);

async function openTab(filePath = "C:/scripts/query.sql") {
  await useQueries.getState().open("test", null, { text: "SELECT 1;", filePath, dirty: true });
  const id = useQueries.getState().activeId!;
  texts.set(id, "SELECT 1;");
  return id;
}

function edit(id: string, text: string) {
  texts.set(id, text);
  useQueries.getState().setDirty(id, true);
}

describe("saving a Query Tab while editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.fileWrite).mockReset().mockResolvedValue(undefined);
    vi.mocked(modelText).mockImplementation((id) => texts.get(id) ?? null);
    texts.clear();
    useQueries.setState({ tabs: [], activeId: null });
    useDialogs.setState({
      confirmUnsaved: vi.fn(async () => "save" as const),
      confirmTransactions: vi.fn(async () => "rollback" as const),
    });
  });

  it("keeps later edits dirty after the earlier text is written", async () => {
    const id = await openTab();
    const write = deferred<void>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(write.promise);
    const saved = saveTab(id);
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledOnce());
    edit(id, "SELECT 2;");
    write.resolve();
    expect(await saved).toBe(true);
    expect(api.fileWrite).toHaveBeenCalledWith("C:/scripts/query.sql", "SELECT 1;");
    expect(tab(id)?.dirty).toBe(true);
    expect(modelText(id)).toBe("SELECT 2;");
  });

  it("clears dirty when the current text matches the saved text", async () => {
    const id = await openTab();
    expect(await saveTab(id)).toBe(true);
    expect(tab(id)?.dirty).toBe(false);
  });

  it("updates the Save As path without marking later edits as saved", async () => {
    const id = await openTab();
    const dialog = deferred<string>();
    vi.mocked(save).mockReturnValueOnce(dialog.promise);
    const saved = saveTab(id, true);
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    edit(id, "SELECT 2;");
    dialog.resolve("C:/scripts/other.sql");
    expect(await saved).toBe(true);
    expect(api.fileWrite).toHaveBeenCalledWith("C:/scripts/other.sql", "SELECT 1;");
    expect(tab(id)).toMatchObject({ filePath: "C:/scripts/other.sql", title: "other.sql", dirty: true });
  });

  it("keeps a tab open if it changes during Close → Save", async () => {
    const id = await openTab();
    const write = deferred<void>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(write.promise);
    const closed = closeTab(id);
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledOnce());
    edit(id, "SELECT 2;");
    write.resolve();
    expect(await closed).toBe(false);
    expect(tab(id)?.dirty).toBe(true);
    expect(api.closeQuery).not.toHaveBeenCalled();
    expect(disposeModel).not.toHaveBeenCalled();
  });

  it("checks for new edits again after the transaction confirmation", async () => {
    const id = await openTab();
    useQueries.setState((state) => ({ tabs: state.tabs.map((item) => ({ ...item, openTransactions: 1 })) }));
    const transaction = deferred<"rollback">();
    const confirm = vi.fn(() => transaction.promise);
    useDialogs.setState({ confirmTransactions: confirm });
    const closed = closeTab(id);
    await vi.waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    edit(id, "SELECT 3;");
    transaction.resolve("rollback");
    expect(await closed).toBe(false);
    expect(tab(id)?.dirty).toBe(true);
    expect(api.closeQuery).not.toHaveBeenCalled();
    expect(disposeModel).not.toHaveBeenCalled();
  });

  it("closes and disposes a tab whose current text was saved", async () => {
    const id = await openTab();
    expect(await closeTab(id)).toBe(true);
    expect(tab(id)).toBeUndefined();
    expect(api.closeQuery).toHaveBeenCalledWith(id);
    expect(disposeModel).toHaveBeenCalledWith(id);
  });

  it("writes repeated saves in request order and keeps each requested snapshot", async () => {
    const id = await openTab();
    const first = deferred<void>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(first.promise);
    const savedFirst = saveTab(id);
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledOnce());
    edit(id, "SELECT 2;");
    const savedSecond = saveTab(id);
    edit(id, "SELECT 3;");
    await Promise.resolve();
    expect(api.fileWrite).toHaveBeenCalledTimes(1);
    first.resolve();
    expect(await savedFirst).toBe(true);
    expect(await savedSecond).toBe(true);
    expect(api.fileWrite).toHaveBeenNthCalledWith(2, "C:/scripts/query.sql", "SELECT 2;");
    expect(tab(id)?.dirty).toBe(true);
  });

  it("serializes writes from different tabs sharing a file", async () => {
    const firstId = await openTab();
    const secondId = await openTab("C:\\scripts\\QUERY.SQL");
    edit(secondId, "SELECT 2;");
    const first = deferred<void>();
    vi.mocked(api.fileWrite).mockReturnValueOnce(first.promise);
    const firstSave = saveTab(firstId);
    await vi.waitFor(() => expect(api.fileWrite).toHaveBeenCalledOnce());
    const secondSave = saveTab(secondId);
    await Promise.resolve();
    expect(api.fileWrite).toHaveBeenCalledTimes(1);
    first.resolve();
    await firstSave;
    expect(await secondSave).toBe(true);
    expect(api.fileWrite).toHaveBeenNthCalledWith(2, "C:\\scripts\\QUERY.SQL", "SELECT 2;");
  });

  it("keeps the tab and edits when writing fails", async () => {
    const id = await openTab();
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("disk full"));
    expect(await closeTab(id)).toBe(false);
    expect(tab(id)?.dirty).toBe(true);
    expect(disposeModel).not.toHaveBeenCalled();
  });

  it("allows a later save to succeed after a failed write", async () => {
    const id = await openTab();
    vi.mocked(api.fileWrite).mockRejectedValueOnce(new Error("disk full"));
    const failed = saveTab(id);
    edit(id, "SELECT 2;");
    const retried = saveTab(id);
    expect(await failed).toBe(false);
    expect(await retried).toBe(true);
    expect(api.fileWrite).toHaveBeenLastCalledWith("C:/scripts/query.sql", "SELECT 2;");
    expect(tab(id)?.dirty).toBe(false);
  });
});
