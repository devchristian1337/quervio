import { describe, expect, it } from "vitest";
import { newConnection, transportWarning } from "@/stores/connections";

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
