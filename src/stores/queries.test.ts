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
  },
}));

const { api } = await import("@/lib/api");
const { useConnections } = await import("@/stores/connections");
const { useDialogs } = await import("@/stores/dialogs");
const { useQueries } = await import("@/stores/queries");

const production: SavedConnection = {
  id: "c1",
  name: "Prod",
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
