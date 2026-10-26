import { describe, expect, it } from "vitest";
import { FormatError, formatScript, sameTokens, splitOnGo } from "@/lib/format-sql";

describe("formatScript", () => {
  it("lays out a query in the SSMS style", () => {
    expect(formatScript("select a.Id,b.Name from dbo.T a join dbo.U b on a.id=b.id where a.x>1 and b.y like '%a%'")).toBe(
      [
        "SELECT a.Id,",
        "    b.Name",
        "FROM dbo.T a",
        "JOIN dbo.U b ON a.id = b.id",
        "WHERE a.x > 1",
        "    AND b.y LIKE '%a%'",
      ].join("\n"),
    );
  });

  it("indents procedural code", () => {
    expect(formatScript("create procedure dbo.p @a int as begin set nocount on; select top (10) * from t with (nolock) where a=@a; end")).toBe(
      [
        "CREATE PROCEDURE dbo.p @a INT",
        "AS",
        "BEGIN",
        "    SET NOCOUNT ON;",
        "",
        "    SELECT TOP (10) *",
        "    FROM t WITH (NOLOCK)",
        "    WHERE a = @a;",
        "END",
      ].join("\n"),
    );
  });

  it("keeps GO lines, with their count, on their own line", () => {
    expect(formatScript("create table t (x int)\ngo\nselect 1 -- one\nGO 5\nselect 2\n")).toBe(
      "CREATE TABLE t (x INT)\ngo\n\nSELECT 1 -- one\nGO 5\n\nSELECT 2\n",
    );
  });

  it("does not split on GO inside strings and comments", () => {
    const script = "select 'a\nGO\nb'\n/* x\ngo\n*/ select 1";
    expect(splitOnGo(script).filter((piece) => piece.kind === "go")).toEqual([]);
    expect(formatScript(script)).toContain("'a\nGO\nb'");
  });

  it("keeps strings, quoted identifiers and comments exactly", () => {
    const script = "-- keep me   as is\nselect N'it''s  here' [Order  Name], \"x  y\" /* two  spaces */ from t";
    const formatted = formatScript(script);
    for (const part of ["-- keep me   as is", "N'it''s  here'", "[Order  Name]", '"x  y"', "/* two  spaces */"]) {
      expect(formatted).toContain(part);
    }
  });

  it("handles T-SQL statements beyond SELECT", () => {
    const script = [
      "declare @t table(id int); insert @t values(1),(2);",
      "update t set c=1 output inserted.c where id in (select id from @t);",
      "IF OBJECT_ID('tempdb..#x') IS NOT NULL DROP TABLE #x;",
      "WITH c AS (SELECT 1 n) MERGE INTO t USING c ON t.n=c.n WHEN MATCHED THEN UPDATE SET n=1 WHEN NOT MATCHED THEN INSERT (n) VALUES (c.n);",
      "select $action, 0x1F, 1e3, cast(1 as decimal(10,2)), case when a>=1 then 'y' else 'n' end from t",
    ].join("\n");
    const formatted = formatScript(script);
    expect(sameTokens(script, formatted)).toBe(true);
    expect(formatted).toContain("DECLARE @t TABLE (id INT);");
    expect(formatted).toContain("    DROP TABLE #x;");
  });

  it("is stable: formatting twice changes nothing", () => {
    const once = formatScript("select a,b from t where x=1\nGO\nexec dbo.p @a=1, @b='x'");
    expect(formatScript(once)).toBe(once);
  });

  it("refuses a script it cannot parse and leaves it alone", () => {
    expect(() => formatScript("select (1")).toThrow(FormatError);
  });

  it("keeps CRLF input working", () => {
    expect(formatScript("select 1\r\nGO\r\nselect 2\r\n")).toBe("SELECT 1\nGO\n\nSELECT 2\n");
  });
});

describe("sameTokens", () => {
  it("ignores layout and the case of words", () => {
    expect(sameTokens("select a,b\nfrom t", "SELECT a,\n    b\nFROM T")).toBe(true);
  });

  it("notices changed strings, operators and N prefixes", () => {
    expect(sameTokens("select 'a'", "select 'A'")).toBe(false);
    expect(sameTokens("where a>=1", "where a> =1")).toBe(false);
    expect(sameTokens("select N'x'", "select N 'x'")).toBe(false);
    expect(sameTokens("select 1e3", "select 1 e3")).toBe(false);
  });
});
