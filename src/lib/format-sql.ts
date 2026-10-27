// Formats a script with Poor Man's T-SQL Formatter (docs/adr/0004).
//
// Each Batch is formatted on its own and the GO lines are kept as written:
// the formatter would join `GO 5` to the line before, which breaks the
// script. The result is accepted only if it has the same tokens as the
// input, so a formatter bug can change the layout but never the code.
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

/** `script` formatted, with GO lines, Batch order and comments kept. */
export function formatScript(script: string, style: FormatStyle = DEFAULT_STYLE): string {
  const options = optionsOf(style);
  const text = script.replace(/\r\n?/g, "\n");
  const pieces = splitOnGo(text);
  const batches = pieces.filter((piece) => piece.kind === "batch").length;
  let batchNumber = 0;
  let formatted = "";
  for (const piece of pieces) {
    if (piece.kind === "go") {
      formatted += (formatted ? "\n" : "") + piece.line.trim();
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

  if (!sameTokens(text, formatted)) {
    throw new FormatError("Formatting would have changed the code, not just its layout; nothing was changed.");
  }
  return formatted;
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
    if (state.kind === "code" && isGo(line)) {
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

function isGo(line: string): boolean {
  return /^\s*go(\s+\d+)?\s*(--.*)?$/i.test(line.replace(/\n$/, ""));
}

type State = { kind: "code" } | { kind: "comment"; depth: number } | { kind: "quoted"; close: string };

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
  const left = tokens(a);
  const right = tokens(b);
  return left.length === right.length && left.every((token, index) => token === right[index]);
}

const TOKEN =
  /--[^\n]*|\/\*[\s\S]*?\*\/|N?'(?:[^']|'')*'|"(?:[^"]|"")*"|\[(?:[^\]]|\]\])*\]|[\w@#$.]+|>=|<=|<>|!=|!<|!>|::|[-+*/%&|^]=|\S/g;

function tokens(script: string): string[] {
  // Nested block comments are not matched as one token; they still compare
  // piece by piece, which is enough to catch a change.
  return (script.match(TOKEN) ?? []).map((token) => {
    if (token.startsWith("--")) return token.trimEnd();
    if (token.startsWith("/*")) return token.replace(/\s+/g, " ");
    if (/^N?'|^"|^\[/.test(token)) return token;
    return token.toUpperCase();
  });
}
