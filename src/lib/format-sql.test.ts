import { describe, expect, it } from "vitest";
import { FormatError, formatRange, formatScript, sameScript, sameTokens, splitOnGo, type LayOut } from "@/lib/format-sql";

// sqruff's own output is tested in crates/quervio-core/src/sql_format.rs;
// these tests cover what the editor adds around it.

const goLines = (script: string) => splitOnGo(script).filter((piece) => piece.kind === "go");

/** A stand-in for sqruff: one line per Batch, keywords in capitals. */
const tidy: LayOut = async (batches) =>
  batches.map((batch) => ({
    text: batch.replace(/\s+/g, " ").trim().replace(/\b(select|from|where)\b/gi, (word) => word.toUpperCase()),
    unparsedLine: null,
  }));

/** A stand-in that lays every Batch out as `text`. */
const always =
  (text: string): LayOut =>
  async (batches) =>
    batches.map(() => ({ text, unparsedLine: null }));

const format = async (script: string, layOut: LayOut = tidy) => (await formatScript(script, undefined, layOut)).text;

describe("formatScript", () => {
  it("lays out each Batch and keeps GO lines, with their count, on their own line", async () => {
    expect(await format("create table t (x int)\ngo\nselect 1 -- one\nGO 5\nselect 2\n")).toBe(
      "create table t (x int)\ngo\n\nSELECT 1 -- one\nGO 5\n\nSELECT 2\n",
    );
  });

  it("sends only the Batches with code, in order", async () => {
    const seen: string[][] = [];
    const spy: LayOut = async (batches, style) => {
      seen.push(batches);
      return tidy(batches, style);
    };
    await formatScript("select 1\ngo\n\ngo\nselect 2", undefined, spy);
    expect(seen).toEqual([["select 1\n", "select 2"]]);
  });

  it("does not split on GO inside strings and comments", async () => {
    const script = "select 'a\nGO\nb'\n/* x\ngo\n*/ select 1";
    expect(goLines(script)).toEqual([]);
    expect(await format(script, always(script))).toContain("'a\nGO\nb'");
  });

  it("refuses a layout that changes the code", async () => {
    await expect(format("select a from t where b>=1", always("SELECT a FROM t WHERE b> =1"))).rejects.toThrow(FormatError);
    await expect(format("select 1", always("SELECT 2"))).rejects.toThrow(FormatError);
  });

  it("refuses N split from its string, which would make N an alias", async () => {
    await expect(format("select N'x'", always("SELECT N 'x'"))).rejects.toThrow(FormatError);
  });

  it("never moves the end of a nested comment", async () => {
    // As written the Server reads `2 / <comment> 1 AND 0=1`. sqruff lexes the
    // nested comment differently and lays it out as below, where the WHERE
    // turns into `2 / 1 OR 1=1`.
    const script = "DELETE FROM dbo.t WHERE id = 2//* /* */\n*/1 AND 0=1 -- */ 1 OR 1=1\n";
    const sqruff = "DELETE FROM dbo.t\nWHERE id = 2/* /* */\n*// 1 AND 0 = 1 -- */ 1 OR 1=1\n";
    await expect(format(script, always(sqruff))).rejects.toThrow(FormatError);
  });

  it("never turns a line with more than GO into a separator", async () => {
    const script = "CREATE PROCEDURE dbo.p AS SELECT 1 -- c\ngo DROP TABLE dbo.t\n";
    expect(goLines(script)).toEqual([]);
    // What sqruff writes: the line keeps its other words.
    expect(goLines(await format(script, always("CREATE PROCEDURE dbo.p AS SELECT 1 -- c\nGO DROP TABLE dbo.t")))).toEqual([]);
    await expect(format(script, always("CREATE PROCEDURE dbo.p AS SELECT 1 -- c\nGO\nDROP TABLE dbo.t"))).rejects.toThrow(
      FormatError,
    );
  });

  it("reads GO lines with Rust's whitespace and counts", async () => {
    // U+FEFF is not White_Space for batch.rs, so this is not a separator.
    expect(goLines("CREATE PROCEDURE dbo.p AS SELECT 1\n﻿go\nDROP TABLE dbo.t\n")).toEqual([]);
    // Rust parses `+5` as a count, so this one is a separator, kept as written.
    expect(goLines("SELECT 1\ngo +5\nSELECT 2\n")).toEqual([{ kind: "go", line: "go +5" }]);
    expect(await format("SELECT 1\ngo +5\nSELECT 2\n")).toBe("SELECT 1\ngo +5\n\nSELECT 2\n");
    expect(goLines("SELECT 1\ngo 99999999999\n")).toEqual([]);
  });

  it("keeps CRLF input working", async () => {
    expect(await format("select 1\r\nGO\r\nselect 2\r\n")).toBe("SELECT 1\nGO\n\nSELECT 2\n");
  });

  it("names the script line that was left as written", async () => {
    const partly: LayOut = async (batches) =>
      batches.map((batch, i) => ({ text: batch, unparsedLine: i === 1 ? 2 : null }));
    const formatted = await formatScript("select 1\nGO\nselect 2\nselect (3\n", undefined, partly);
    expect(formatted.unparsedLine).toBe(4);
  });
});

describe("formatRange", () => {
  it("formats a selection in place", async () => {
    const document = "select 1\nselect a,b from t\n";
    expect((await formatRange(document, 9, document.length, undefined, tidy)).text).toBe("SELECT a,b FROM t\n");
  });

  it("counts the line left as written in the document", async () => {
    const document = "select 1\nselect 2\nselect (3\n";
    const partly: LayOut = async (batches) => batches.map((batch) => ({ text: batch, unparsedLine: 2 }));
    expect((await formatRange(document, 9, document.length, undefined, partly)).unparsedLine).toBe(3);
  });

  it("refuses a selection that starts inside a comment", async () => {
    const document = "DELETE FROM dbo.t /*\nok */ WHERE id = 1 -- */\n";
    await expect(formatRange(document, document.indexOf("ok"), document.length, undefined, tidy)).rejects.toThrow(
      /inside a comment/,
    );
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
