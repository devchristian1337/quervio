import { describe, expect, it } from "vitest";
import { byGroup, newConnection, transportWarning } from "@/stores/connections";

describe("newConnection", () => {
  it("checks the server certificate by default", () => {
    const connection = newConnection();
    expect(connection.encrypt).toBe("mandatory");
    expect(connection.trustServerCertificate).toBe(false);
    expect(transportWarning(connection)).toBeNull();
  });
});

describe("transportWarning", () => {
  it("warns when the certificate is trusted without Strict", () => {
    expect(transportWarning({ encrypt: "mandatory", trustServerCertificate: true })).toMatch(/not checked/);
  });

  it("does not warn under Strict, which ignores the trust flag", () => {
    expect(transportWarning({ encrypt: "strict", trustServerCertificate: true })).toBeNull();
  });

  it("warns that Optional encryption can be stripped", () => {
    expect(transportWarning({ encrypt: "optional", trustServerCertificate: false })).toMatch(/turned off/);
  });
});

describe("byGroup", () => {
  const connection = (name: string, group: string | null) => ({ ...newConnection(), id: name, name, server: name, group });

  it("lists the groups by name, then the connections in none, each by name", () => {
    const groups = byGroup([
      connection("Zeta", null),
      connection("srv 10", "Camilliani"),
      connection("alpha", null),
      connection("srv 9", "Camilliani"),
      connection("Ricoveri", "aurelia"),
    ]);
    expect(groups.map((g) => [g.group, g.connections.map((c) => c.name)])).toEqual([
      ["aurelia", ["Ricoveri"]],
      ["Camilliani", ["srv 9", "srv 10"]],
      [null, ["alpha", "Zeta"]],
    ]);
  });
});
