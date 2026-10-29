import { describe, expect, it } from "vitest";
import type { SavedConnection, SsmsConnection } from "@/lib/api";
import { environmentFromName, matchSaved } from "@/lib/ssms-import";

const sa = { kind: "sql", userName: "sa" } as const;

function registered(group: string, name: string, database: string, server = "10.0.0.5"): SsmsConnection {
  return {
    id: `registered:${group}/${name}`,
    name,
    groups: [group],
    server,
    authentication: sa,
    defaultDatabase: database,
    encrypt: "optional",
    trustServerCertificate: true,
    lastUsed: null,
    source: "registered",
    ssmsVersion: null,
    hasPassword: true,
  };
}

function saved(id: string, name: string, group: string | null, database: string, server = "10.0.0.5"): SavedConnection {
  return {
    id,
    name,
    group,
    server,
    authentication: sa,
    defaultDatabase: database,
    environment: "production",
    encrypt: "optional",
    trustServerCertificate: true,
  };
}

const app = registered("Aurelia", "AURELIA [APP SERVER]", "H2O");
const test = registered("Aurelia", "AURELIA [TEST SERVER]", "H2O_TEST");

describe("matchSaved", () => {
  it("pairs APP and TEST on one server by name and database, one to one", () => {
    const statuses = matchSaved(
      [app, test],
      [saved("a", "Aurelia / AURELIA [APP SERVER]", null, "H2O"), saved("t", "Aurelia / AURELIA [TEST SERVER]", null, "H2O_TEST")],
    );
    expect(statuses.get(app.id)).toMatchObject({ kind: "move", existing: { id: "a" }, group: "Aurelia", name: "AURELIA [APP SERVER]" });
    expect(statuses.get(test.id)).toMatchObject({ kind: "move", existing: { id: "t" }, name: "AURELIA [TEST SERVER]" });
  });

  it("repairs a connection an earlier import named after the other server", () => {
    // 0.1.15 moved both SSMS servers onto "a" (the APP database), which ended named TEST.
    const statuses = matchSaved(
      [app, test],
      [saved("a", "AURELIA [TEST SERVER]", "Aurelia", "H2O"), saved("t", "Aurelia / AURELIA [TEST SERVER]", null, "H2O_TEST")],
    );
    expect(statuses.get(test.id)).toMatchObject({ kind: "move", existing: { id: "t" } });
    expect(statuses.get(app.id)).toMatchObject({ kind: "move", existing: { id: "a" }, name: "AURELIA [APP SERVER]" });
  });

  it("leaves placed connections alone and creates the missing ones", () => {
    const statuses = matchSaved([app, test], [saved("a", "AURELIA [APP SERVER]", "Aurelia", "H2O")]);
    expect(statuses.get(app.id)).toEqual({ kind: "saved" });
    expect(statuses.get(test.id)).toEqual({ kind: "new", environment: "test" });
  });

  it("knows a history entry by server and login", () => {
    const history: SsmsConnection = { ...app, id: "history:x", name: "", groups: [], source: "history" };
    expect(matchSaved([history], [saved("a", "", null, "other")]).get("history:x")).toEqual({ kind: "saved" });
    expect(matchSaved([history], []).get("history:x")).toEqual({ kind: "new", environment: null });
  });

  it("gives a TEST server imported as Production its Environment", () => {
    const placed = { ...saved("t", "AURELIA [TEST SERVER]", "Aurelia", "H2O_TEST") };
    expect(matchSaved([test], [placed]).get(test.id)).toMatchObject({ kind: "move", environment: "test", group: "Aurelia" });
    expect(matchSaved([test], [{ ...placed, environment: "test" }]).get(test.id)).toEqual({ kind: "saved" });
  });

  it("reads the Environment from a server's name", () => {
    expect(environmentFromName("Villa Margherita [TEST SERVER]")).toBe("test");
    expect(environmentFromName("CDR Collaudo")).toBe("test");
    expect(environmentFromName("H2O DEV")).toBe("development");
    expect(environmentFromName("Villa Margherita [APP SERVER]")).toBeNull();
    expect(environmentFromName("Testaccio")).toBeNull();
  });
});
