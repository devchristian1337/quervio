import { describe, it, expect } from "vitest";
import {
  backupScript,
  foreignKeyScript,
  maintenanceScript,
  restoreScript,
  tableScript,
  validateRestoreChain,
  type ColumnDefinition,
} from "./sql-management";
const column: ColumnDefinition = {
  name: "id",
  type: "int",
  nullable: false,
  identity: false,
  seed: "1",
  increment: "1",
  computed: "",
  defaultValue: "",
};
describe("administrative scripts", () => {
  it("renames an existing column without dropping its data", () => {
    const original = {
      schema: "dbo",
      name: "t",
      columns: [column],
      primaryKey: [],
    };
    const sql = tableScript(
      {
        ...original,
        columns: [{ ...column, originalName: "id", name: "renamed" }],
      },
      original,
    );
    expect(sql).toContain("sp_rename");
    expect(sql).not.toContain("DROP COLUMN");
    expect(sql).toContain("ROLLBACK TRANSACTION");
  });
  it("replaces foreign keys inside a rollback-protected transaction", () => {
    const sql = foreignKeyScript({
      schema: "dbo",
      table: "t",
      name: "fk",
      columns: ["a"],
      referencedSchema: "dbo",
      referencedTable: "r",
      referencedColumns: ["a"],
      onDelete: "NO ACTION",
      onUpdate: "NO ACTION",
      replace: true,
    });
    expect(sql).toContain("BEGIN TRANSACTION");
    expect(sql).toContain("ROLLBACK TRANSACTION");
  });
  it("compares backup LSNs without floating-point precision loss", () => {
    expect(() =>
      validateRestoreChain([
        {
          path: "full.bak",
          position: 1,
          kind: "database",
          backupType: 1,
          checkpointLsn: "90071992547409930",
          lastLsn: "90071992547409940",
          databaseName: "test",
        },
        {
          path: "diff.bak",
          position: 1,
          kind: "database",
          backupType: 5,
          databaseBackupLsn: "90071992547409931",
          lastLsn: "90071992547409950",
          databaseName: "test",
        },
      ]),
    ).toThrow(/does not reference/);
  });
  it("rejects gaps in a restored log chain", () => {
    expect(() =>
      validateRestoreChain([
        {
          path: "full.bak",
          position: 1,
          kind: "database",
          backupType: 1,
          checkpointLsn: "100",
          lastLsn: "200",
          databaseName: "test",
        },
        {
          path: "log.trn",
          position: 1,
          kind: "log",
          backupType: 2,
          firstLsn: "201",
          lastLsn: "300",
          databaseName: "test",
        },
      ]),
    ).toThrow(/gap/);
  });
  it("detects cycles that include the default next-task edge", () => {
    const base = {
      kind: "sql" as const,
      sql: "SELECT 1",
      schema: "dbo",
      table: "",
      path: "",
      days: 30,
    };
    expect(() =>
      maintenanceScript(
        "job",
        "test",
        [
          { ...base, id: "a" },
          { ...base, id: "b", nextSuccess: "a" },
        ],
        0,
        0,
      ),
    ).toThrow(/cycles/);
  });
  it("quotes identifiers and backup paths without changing their meaning", () => {
    expect(
      backupScript({
        database: "a]b",
        path: "D:\\O'Brien.bak",
        kind: "full",
        copyOnly: true,
        compression: false,
        checksum: true,
      }),
    ).toContain("[a]]b] TO DISK=N'D:\\O''Brien.bak'");
  });
  it("rejects copy-only differential backups", () =>
    expect(() =>
      backupScript({
        database: "test",
        path: "a.bak",
        kind: "differential",
        copyOnly: true,
        compression: false,
        checksum: true,
      }),
    ).toThrow());
  it("never recreates an existing table for an identity change", () => {
    const original = {
      schema: "dbo",
      name: "t",
      columns: [column],
      primaryKey: [],
    };
    expect(() =>
      tableScript(
        { ...original, columns: [{ ...column, identity: true }] },
        original,
      ),
    ).toThrow(/never recreates/);
  });
  it("changes only the selected column", () => {
    const original = {
      schema: "dbo",
      name: "t",
      columns: [column],
      primaryKey: [],
    };
    expect(
      tableScript(
        { ...original, columns: [{ ...column, nullable: true }] },
        original,
      ),
    ).toContain("ALTER TABLE [dbo].[t] ALTER COLUMN [id] int NULL;");
  });
  it("validates composite foreign key mappings", () =>
    expect(() =>
      foreignKeyScript({
        schema: "dbo",
        table: "t",
        name: "fk",
        columns: ["a", "b"],
        referencedSchema: "dbo",
        referencedTable: "r",
        referencedColumns: ["a"],
        onDelete: "NO ACTION",
        onUpdate: "NO ACTION",
      }),
    ).toThrow());
  it("restores a chain without recovering intermediate backups", () => {
    const script = restoreScript(
      "copy",
      [
        { path: "full.bak", kind: "database", position: 1 },
        { path: "log.trn", kind: "log", position: 2 },
      ],
      "2026-10-28T10:00:00",
      [],
      true,
      false,
    );
    expect(script).toContain("FILE=1, NORECOVERY");
    expect(script).toContain("FILE=2, RECOVERY");
    expect(script).toContain("STOPAT=N'2026-10-28 10:00:00'");
    expect(script).not.toContain("REPLACE");
  });
  it("deploys maintenance to Agent with no dependency on the desktop", () => {
    expect(
      maintenanceScript(
        "nightly",
        "test",
        [
          {
            id: "a",
            kind: "statistics",
            schema: "dbo",
            table: "t",
            path: "",
            sql: "",
            days: 30,
          },
        ],
        2,
        30,
      ),
    ).toContain("@active_start_time=23000");
  });
  it("refuses cyclic flows", () => {
    expect(() =>
      maintenanceScript(
        "job",
        "test",
        [
          {
            id: "a",
            kind: "sql",
            sql: "SELECT 1",
            schema: "dbo",
            table: "t",
            path: "",
            days: 30,
            nextSuccess: "a",
          },
        ],
        0,
        0,
      ),
    ).toThrow(/cycles/);
  });
});
