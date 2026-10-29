import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedConnection } from "@/lib/api";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/components/ui/basic-toast", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: {
    openQuery: vi.fn(async () => ({ serverName: "prod1", version: "16.0", database: "master" })),
    closeQuery: vi.fn(async () => {}),
    checkScript: vi.fn(async () => ({ findings: [{ kind: "drop", target: "dbo.t", line: 1 }], uncertain: false })),
    executeQuery: vi.fn(async () => "succeeded"),
    resultRows: vi.fn(async () => window1x1("a")),
  },
}));

// A row window as Rust encodes it (src/lib/results.ts): one row, one text cell.
function window1x1(text: string) {
  const bytes = new TextEncoder().encode(text);
  const view = new DataView(new ArrayBuffer(13 + bytes.length));
  view.setUint32(0, 1, true);
  view.setUint32(4, 1, true);
  view.setUint8(8, 0);
  view.setUint32(9, bytes.length, true);
  new Uint8Array(view.buffer).set(bytes, 13);
  return view.buffer;
}

const { api } = await import("@/lib/api");
const { firstBlock } = await import("@/lib/results");
const { useConnections } = await import("@/stores/connections");
const { useDialogs } = await import("@/stores/dialogs");
const { useQueries } = await import("@/stores/queries");

const production: SavedConnection = {
  id: "c1",
  name: "Prod",
  group: null,
  server: "prod1",
  authentication: { kind: "sql", userName: "u" },
  defaultDatabase: null,
  environment: "production",
  encrypt: "mandatory",
  trustServerCertificate: false,
};

const confirmDestructive = vi.fn(async () => false);

async function openTab(connection: SavedConnection) {
  useConnections.setState({ connections: [connection] });
  await useQueries.getState().open(connection.id);
  const tabs = useQueries.getState().tabs;
  return tabs[tabs.length - 1].id;
}

const drop = { text: "DROP TABLE dbo.t", baseLine: 0 };

describe("the Production guard of a Query Tab", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useQueries.setState({ tabs: [], activeId: null });
    useDialogs.setState({ confirmDestructive });
  });

  it("still asks after the tab's Saved Connection is deleted", async () => {
    const id = await openTab(production);
    useConnections.setState({ connections: [] });
    await useQueries.getState().execute(id, drop);
    expect(confirmDestructive).toHaveBeenCalledOnce();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("still asks after the connection is pointed at another server as Development", async () => {
    const id = await openTab(production);
    useConnections.setState({ connections: [{ ...production, server: "dev1", environment: "development" }] });
    await useQueries.getState().execute(id, drop);
    expect(confirmDestructive).toHaveBeenCalledOnce();
    expect(api.executeQuery).not.toHaveBeenCalled();
  });

  it("asks once a connection is marked Production, even for tabs opened before", async () => {
    const id = await openTab({ ...production, environment: "development" });
    useConnections.setState({ connections: [production] });
    await useQueries.getState().execute(id, drop);
    expect(confirmDestructive).toHaveBeenCalledOnce();
  });

  it("tells the Session whether the user confirmed", async () => {
    const id = await openTab(production);
    confirmDestructive.mockResolvedValueOnce(true);
    await useQueries.getState().execute(id, drop);
    expect(vi.mocked(api.executeQuery).mock.calls[0][4]).toBe(true);

    const dev = await openTab({ ...production, id: "c2", environment: "development" });
    await useQueries.getState().execute(dev, drop);
    // Not confirmed: the Session refuses it if it is on Production after all.
    expect(vi.mocked(api.executeQuery).mock.calls[1][4]).toBe(false);
  });
});

describe("an Execution's running state", () => {
  const development = { ...production, id: "c3", environment: "development" as const };
  const select = { text: "SELECT 1", baseLine: 0 };
  // Holds the Execution open and hands back its event channel.
  function pendingExecution() {
    let finish = () => {};
    let channel: { onmessage: (event: unknown) => void } | undefined;
    vi.mocked(api.executeQuery).mockImplementationOnce((...args) => {
      channel = args[5] as unknown as typeof channel;
      return new Promise((resolve) => (finish = () => resolve("succeeded")));
    });
    return { send: (event: unknown) => channel?.onmessage(event), finish: () => finish() };
  }
  const tab = (id: string) => useQueries.getState().tabs.find((t) => t.id === id)!;
  const old = { text: "old", isError: false };

  beforeEach(() => {
    vi.clearAllMocks();
    useQueries.setState({ tabs: [], activeId: null });
  });

  it("replaces the last output in one step when it finishes quickly", async () => {
    const id = await openTab(development);
    useQueries.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, messages: [old] })) }));
    const run = pendingExecution();
    const done = useQueries.getState().execute(id, select);
    expect(tab(id)).toMatchObject({ status: "executing", longRunning: false, messages: [old] });

    run.send({ type: "message", text: "new", isError: false });
    run.send({ type: "resultSetStarted", index: 0, columns: [{ name: "c", kind: "text" }] });
    run.send({ type: "resultSetFinished", index: 0, rows: 1 });
    run.send({ type: "finished", outcome: "succeeded", elapsedMs: 5, database: "master", openTransactions: 0 });
    expect(tab(id)).toMatchObject({ messages: [old], resultSets: [] });

    run.finish();
    await done;
    expect(tab(id)).toMatchObject({
      status: "ready",
      longRunning: false,
      outcome: "succeeded",
      messages: [{ type: "message", text: "new", isError: false }],
      resultSets: [{ index: 0, rows: 1, done: true }],
      view: "results",
    });
    // Its grid draws the first rows at once.
    expect(firstBlock(id, tab(id).runId, 0)).toEqual([[{ kind: 0, text: "a" }]]);
  });

  it("shows itself running once it outlasts the threshold", async () => {
    vi.useFakeTimers();
    try {
      const id = await openTab(development);
      useQueries.setState((s) => ({ tabs: s.tabs.map((t) => ({ ...t, messages: [old] })) }));
      const run = pendingExecution();
      const done = useQueries.getState().execute(id, select);
      vi.advanceTimersByTime(299);
      expect(tab(id)).toMatchObject({ longRunning: false, messages: [old] });
      vi.advanceTimersByTime(1);
      expect(tab(id)).toMatchObject({ longRunning: true, messages: [], outcome: null });

      run.finish();
      await done;
      expect(tab(id)).toMatchObject({ status: "ready", longRunning: false });
    } finally {
      vi.useRealTimers();
    }
  });
});
