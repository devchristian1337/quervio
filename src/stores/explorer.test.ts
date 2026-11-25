import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TreeNode } from "@/stores/explorer";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(),
  databases: vi.fn(),
  objects: vi.fn(),
  tableChildren: vi.fn(),
}));

vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  api: {
    connect: mocks.connect,
    disconnect: mocks.disconnect,
    databases: mocks.databases,
    objects: mocks.objects,
    tableChildren: mocks.tableChildren,
  },
}));
vi.mock("@/lib/management-api", () => ({
  management: { read: vi.fn() },
  records: vi.fn(() => []),
}));

const { serverKey, useExplorer } = await import("@/stores/explorer");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useExplorer.setState({ expanded: {}, children: {}, filters: {}, selected: null, servers: {}, context: null });
});

describe("Object Explorer async races and key isolation", () => {
  it("ignores late connect/load responses after disconnect()", async () => {
    const conn = deferred<{ serverName: string; version: string; database: string }>();
    mocks.connect.mockReturnValueOnce(conn.promise);
    mocks.disconnect.mockResolvedValueOnce(undefined);

    const serverNode: TreeNode = {
      key: serverKey("c1"),
      label: "Prod",
      kind: { type: "server", connectionId: "c1" },
      expandable: true,
    };

    const expanding = useExplorer.getState().expand(serverNode);
    await useExplorer.getState().disconnect("c1");
    conn.resolve({ serverName: "prod", version: "16.0", database: "master" });
    await expanding;

    expect(useExplorer.getState().servers["c1"]).toBeUndefined();
    expect(useExplorer.getState().children[serverNode.key]).toBeUndefined();
  });

  it("ignores stale responses from overlapping refresh() calls", async () => {
    const slow = deferred<{ name: string; schema: string; objectId: number; detail: null; system: boolean }[]>();
    const fast = deferred<{ name: string; schema: string; objectId: number; detail: null; system: boolean }[]>();
    mocks.objects.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const folder: TreeNode = {
      key: "s:c1/dbs/db:App/tables",
      label: "Tables",
      kind: { type: "objectFolder", connectionId: "c1", database: "App", folder: "tables" },
      expandable: true,
    };

    const first = useExplorer.getState().refresh(folder);
    const second = useExplorer.getState().refresh(folder);

    fast.resolve([{ name: "FreshTable", schema: "dbo", objectId: 2, detail: null, system: false }]);
    await second;
    slow.resolve([{ name: "StaleTable", schema: "dbo", objectId: 1, detail: null, system: false }]);
    await first;

    expect(useExplorer.getState().children[folder.key]).toMatchObject({
      status: "ready",
      nodes: [expect.objectContaining({ objectName: "FreshTable" })],
    });
  });

  it("isolates sibling databases whose names contain '/' so refresh/prune never collides", async () => {
    mocks.databases.mockResolvedValueOnce([
      { name: "App", schema: null, objectId: null, detail: null, system: false },
      { name: "App/Staging", schema: null, objectId: null, detail: null, system: false },
      { name: "App/tables", schema: null, objectId: null, detail: null, system: false },
    ]);

    const dbsNode: TreeNode = {
      key: "s:c1/dbs",
      label: "Databases",
      kind: { type: "databases", connectionId: "c1" },
      expandable: true,
    };
    await useExplorer.getState().expand(dbsNode);
    const loaded = useExplorer.getState().children[dbsNode.key];
    expect(loaded?.status).toBe("ready");
    if (loaded?.status !== "ready") return;

    const appNode = loaded.nodes.find((n) => n.label === "App")!;
    const stagingNode = loaded.nodes.find((n) => n.label === "App/Staging")!;
    const tablesNamedDb = loaded.nodes.find((n) => n.label === "App/tables")!;

    await useExplorer.getState().expand(appNode);
    await useExplorer.getState().expand(stagingNode);
    await useExplorer.getState().expand(tablesNamedDb);

    // Database named "App/tables" must not collide with App's "tables" folder key.
    const appChildren = useExplorer.getState().children[appNode.key];
    const appTablesFolder = appChildren?.status === "ready" ? appChildren.nodes.find((n) => n.label === "Tables") : undefined;
    expect(appTablesFolder?.key).not.toBe(tablesNamedDb.key);

    // Refreshing "App" must keep sibling DBs "App/Staging" and "App/tables" intact.
    await useExplorer.getState().refresh(appNode);
    expect(useExplorer.getState().expanded[stagingNode.key]).toBe(true);
    expect(useExplorer.getState().children[stagingNode.key]?.status).toBe("ready");
    expect(useExplorer.getState().expanded[tablesNamedDb.key]).toBe(true);
    expect(useExplorer.getState().children[tablesNamedDb.key]?.status).toBe("ready");
  });
});
