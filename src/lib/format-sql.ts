// Formats a script with Poor Man's T-SQL Formatter (docs/adr/0004).
//
// Each Batch is formatted on its own and the GO lines are kept as written:
// the formatter would join `GO 5` to the line before, which breaks the
// script. The result is accepted only if it splits into the same Batches
// with the same tokens as the input, read the way SQL Server reads them, so
// a formatter bug can change the layout but never the code.
import "@/lib/node-global";
import { formatSql, type FormatOptions } from "poor-mans-t-sql-formatter";

/** Settings > Editor > Formatting. */
export interface FormatStyle {
  uppercaseKeywords: boolean;
  indent: "2" | "4" | "tab";
}

const DEFAULT_STYLE: FormatStyle = { uppercaseKeywords: true, indent: "4" };

function optionsOf(style: FormatStyle): FormatOptions {
  return {
    indent: style.indent === "tab" ? "	" : " ".repeat(Number(style.indent)),
    uppercaseKeywords: style.uppercaseKeywords,
    // Never rewrite keywords (PROC → PROCEDURE): layout and case only.
    keywordStandardization: false,
  };
}

export class FormatError extends Error {}

const CHANGED_CODE = "Formatting would have changed the code, not just its layout; nothing was changed.";

/** `script` formatted, with GO lines, Batch order and comments kept. */
export function formatScript(script: string, style: FormatStyle = DEFAULT_STYLE): string {
  const options = optionsOf(style);
  const text = script.replace(/\r\n?/g, "\n");
  // The formatter reads `//` as a line comment, which T-SQL has not: it
  // would lay out what the Server reads as code, or the other way round.
  if (codeTokens(text).some((token, i, all) => token.text === "/" && all[i + 1]?.text === "/" && all[i + 1].start === token.start + 1)) {
    throw new FormatError("The script has `//`, which the formatter misreads as a comment; nothing was changed.");
  }
  const pieces = splitOnGo(text);
  const batches = pieces.filter((piece) => piece.kind === "batch").length;
  let batchNumber = 0;
  let formatted = "";
  for (const piece of pieces) {
    if (piece.kind === "go") {
      formatted += (formatted ? "\n" : "") + piece.line;
      continue;
    }
    batchNumber += 1;
    if (piece.text.trim() === "") continue;
    const result = formatSql(piece.text, options);
    if (result.errorFound) {
      const where = batches > 1 ? `batch ${batchNumber}` : "the script";
      throw new FormatError(`The formatter could not parse ${where}; nothing was changed.`);
    }
    // A blank line after each GO, as SSMS scripts usually have.
    formatted += (formatted ? "\n\n" : "") + result.text.replace(/\r\n?/g, "\n").trim();
  }
  if (text.endsWith("\n")) formatted += "\n";

  if (!sameScript(text, formatted)) throw new FormatError(CHANGED_CODE);
  return formatted;
}

/**
 * The replacement for `document.slice(start, end)`, formatted. The
 * selection must start outside comments and strings, and the whole
 * document must still mean the same with the replacement in place.
 */
export function formatRange(document: string, start: number, end: number, style: FormatStyle = DEFAULT_STYLE): string {
  const before = document.slice(0, start);
  if (stateAfter(before.replace(/\r\n?/g, "\n")).kind !== "code") {
    throw new FormatError("The selection starts inside a comment or string; format the whole document instead.");
  }
  const formatted = formatScript(document.slice(start, end), style);
  if (!sameScript(document, before + formatted + document.slice(end))) throw new FormatError(CHANGED_CODE);
  return formatted;
}

/** Whether two scripts have the same Batches, GO lines and tokens. */
export function sameScript(a: string, b: string): boolean {
  const left = splitOnGo(a.replace(/\r\n?/g, "\n"));
  const right = splitOnGo(b.replace(/\r\n?/g, "\n"));
  return (
    left.length === right.length &&
    left.every((piece, i) => {
      const other = right[i];
      if (piece.kind === "go") return other.kind === "go" && goCount(piece.line) === goCount(other.line);
      return other.kind === "batch" && sameTokens(piece.text, other.text);
    })
  );
}

type Piece = { kind: "batch"; text: string } | { kind: "go"; line: string };

/**
 * Splits on lines that are only `GO` (with an optional count and `--`
 * comment) outside strings, quoted identifiers and block comments: the
 * rules of crates/quervio-core/src/batch.rs.
 */
export function splitOnGo(script: string): Piece[] {
  const pieces: Piece[] = [];
  let current = "";
  let state: State = { kind: "code" };
  for (const line of script.split(/(?<=\n)/)) {
    if (state.kind === "code" && goCount(line.replace(/\n$/, "")) !== null) {
      pieces.push({ kind: "batch", text: current }, { kind: "go", line: line.replace(/\n$/, "") });
      current = "";
      continue;
    }
    current += line;
    state = scan(line, state);
  }
  pieces.push({ kind: "batch", text: current });
  return pieces;
}

/**
 * The repeat count when `line` is a GO separator, exactly as
 * `separator` in batch.rs decides it: Unicode White_Space between words
 * (not U+FEFF, which JavaScript's `\s` includes) and a count that Rust
 * parses as a u32, a leading `+` included.
 */
function goCount(line: string): number | null {
  const comment = line.indexOf("--");
  const words = (comment === -1 ? line : line.slice(0, comment)).split(/\p{White_Space}+/u).filter(Boolean);
  if (words.length === 0 || !/^go$/i.test(words[0])) return null;
  if (words.length === 1) return 1;
  if (words.length > 2 || !/^\+?\d+$/.test(words[1])) return null;
  const count = Number(words[1].replace(/^\+/, ""));
  return count <= 0xffff_ffff ? count : null;
}

type State = { kind: "code" } | { kind: "comment"; depth: number } | { kind: "quoted"; close: string };

function stateAfter(text: string): State {
  let state: State = { kind: "code" };
  for (const line of text.split(/(?<=\n)/)) state = scan(line, state);
  return state;
}

function scan(line: string, state: State): State {
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    const next = line[i + 1];
    if (state.kind === "code") {
      if (c === "-" && next === "-") return state;
      if (c === "/" && next === "*") {
        state = { kind: "comment", depth: 1 };
        i++;
      } else if (c === "'" || c === '"') state = { kind: "quoted", close: c };
      else if (c === "[") state = { kind: "quoted", close: "]" };
    } else if (state.kind === "comment") {
      if (c === "/" && next === "*") {
        state = { kind: "comment", depth: state.depth + 1 };
        i++;
      } else if (c === "*" && next === "/") {
        state = state.depth === 1 ? { kind: "code" } : { kind: "comment", depth: state.depth - 1 };
        i++;
      }
    } else if (c === state.close) {
      // A doubled closing character is an escaped one.
      if (next === state.close) i++;
      else state = { kind: "code" };
    }
  }
  return state;
}

/**
 * Whether two scripts differ only in layout and the case of words.
 * Strings, quoted identifiers and comments must match exactly (comments
 * up to whitespace); operators like `>=` count as one token.
 */
export function sameTokens(a: string, b: string): boolean {
  const left = codeTokens(a).map((token) => token.text);
  const right = codeTokens(b).map((token) => token.text);
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

// Everything but block comments, which nest and are read by hand.
const TOKEN =
  /--[^\n]*|N?'(?:[^']|'')*'|"(?:[^"]|"")*"|\[(?:[^\]]|\]\])*\]|[\w@#$.]+|>=|<=|<>|!=|!<|!>|::|[-+*/%&|^]=|\S/y;

/** The tokens of `script` as SQL Server reads them, block comments nested. */
function codeTokens(script: string): { text: string; start: number }[] {
  const tokens: { text: string; start: number }[] = [];
  let i = 0;
  while (i < script.length) {
    if (/\s/.test(script[i])) {
      i++;
      continue;
    }
    const start = i;
    let token: string;
    if (script.startsWith("/*", i)) {
      let depth = 0;
      while (i < script.length) {
        if (script.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (script.startsWith("*/", i)) {
          depth--;
          i += 2;
          if (depth === 0) break;
        } else i++;
      }
      token = script.slice(start, i).replace(/\s+/g, " ");
    } else {
      TOKEN.lastIndex = i;
      const match = TOKEN.exec(script)!;
      i = TOKEN.lastIndex;
      token = match[0];
      if (token.startsWith("--")) token = token.trimEnd();
      else if (!/^N?'|^"|^\[/.test(token)) token = token.toUpperCase();
    }
    tokens.push({ text: token, start });
  }
  return tokens;
}
