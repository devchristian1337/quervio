import { describe, expect, it } from "vitest";
import { FormatError, formatRange, formatScript, sameScript, sameTokens, splitOnGo } from "@/lib/format-sql";

const goLines = (script: string) => splitOnGo(script).filter((piece) => piece.kind === "go");

/** The formatted script, or null when the formatter refuses it. */
function formattedOrRefused(script: string): string | null {
  try {
    return formatScript(script);
  } catch (error) {
    if (error instanceof FormatError) return null;
    throw error;
  }
}

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

  it("follows the formatting settings", () => {
    expect(formatScript("select a,b from t where x=1", { uppercaseKeywords: false, indent: "2" })).toBe(
      ["select a,", "  b", "from t", "where x = 1"].join("\n"),
    );
    expect(formatScript("select a,b from t", { uppercaseKeywords: true, indent: "tab" })).toContain("\n\tb");
  });

  it("keeps CRLF input working", () => {
    expect(formatScript("select 1\r\nGO\r\nselect 2\r\n")).toBe("SELECT 1\nGO\n\nSELECT 2\n");
  });

  it("never moves the end of a nested comment", () => {
    // As written the Server reads `2 / <comment> 1 AND 0=1`; laid out by a
    // formatter that sees `//` as a comment, `*/` would become `* /` and
    // the WHERE would turn into `2 / 1 OR 1=1`.
    expect(() => formatScript("DELETE FROM dbo.t WHERE id = 2//* /* */\n*/1 AND 0=1 -- */ 1 OR 1=1\n")).toThrow(FormatError);
  });

  it("refuses `//`, which the formatter misreads as a comment", () => {
    expect(() => formatScript("select 4//2")).toThrow(/`\/\/`/);
    expect(formatScript("select '//' -- a // b\n")).toContain("'//'");
  });

  it("never turns a line with more than GO into a separator", () => {
    const script = "CREATE PROCEDURE dbo.p AS SELECT 1 -- c\ngo DROP TABLE dbo.t\n";
    expect(goLines(script)).toEqual([]);
    const formatted = formattedOrRefused(script);
    if (formatted !== null) expect(goLines(formatted)).toEqual([]);
  });

  it("reads GO lines with Rust's whitespace and counts", () => {
    // U+FEFF is not White_Space for batch.rs, so this is not a separator,
    // and formatting must not trim it into one.
    const bom = "CREATE PROCEDURE dbo.p AS SELECT 1\n﻿go\nDROP TABLE dbo.t\n";
    expect(goLines(bom)).toEqual([]);
    const formatted = formattedOrRefused(bom);
    if (formatted !== null) expect(goLines(formatted)).toEqual([]);

    // Rust parses `+5` as a count, so this one is a separator, kept as written.
    expect(goLines("SELECT 1\ngo +5\nSELECT 2\n")).toEqual([{ kind: "go", line: "go +5" }]);
    expect(formatScript("SELECT 1\ngo +5\nSELECT 2\n")).toBe("SELECT 1\ngo +5\n\nSELECT 2\n");
    expect(goLines("SELECT 1\ngo 99999999999\n")).toEqual([]);
  });
});

describe("formatRange", () => {
  it("formats a selection in place", () => {
    const document = "select 1\nselect a,b from t\n";
    expect(formatRange(document, 9, document.length)).toBe("SELECT a,\n    b\nFROM t\n");
  });

  it("refuses a selection that starts inside a comment", () => {
    const document = "DELETE FROM dbo.t /*\nok */ WHERE id = 1 -- */\n";
    expect(() => formatRange(document, document.indexOf("ok"), document.length)).toThrow(/inside a comment/);
  });
});

describe("sameScript", () => {
  it("notices a new or lost GO line", () => {
    expect(sameScript("select 1 -- c\ngo select 2", "select 1 -- c\ngo\nselect 2")).toBe(false);
    expect(sameScript("select 1\ngo\nselect 2", "select 1\n\nselect 2")).toBe(false);
    expect(sameScript("select 1\nGO 2\n", "SELECT 1\ngo 2\n")).toBe(true);
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

  it("reads nested block comments as SQL Server does", () => {
    expect(sameTokens("a /* x /* y */ */ b", "a /* x /* y */ */ b")).toBe(true);
    expect(sameTokens("a /* x /* y */ */ b", "a /* x /* y */ * / b")).toBe(false);
    expect(sameTokens("2 / /* /* */\n*/ 1 AND 0=1 -- */ 1 OR 1=1", "2 / /* /* */\n* / 1 AND 0 = 1 -- */ 1 OR 1=1")).toBe(false);
  });
});
