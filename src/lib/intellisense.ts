import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { monaco } from "@/lib/monaco";
import {
  management,
  records,
  type Context,
  type DataTable,
} from "@/lib/management-api";
import {
  COMPLETABLE_TYPES,
  FUNCTIONS,
  KEYWORDS,
  declaredVariables,
  findObject,
  identifier,
  qualifierBefore,
  resolveQualifier,
  statementAround,
  tableReferences,
  type CatalogObject,
} from "@/lib/sql-completion";
import { useQueries } from "@/stores/queries";
import { useTemplates } from "@/stores/templates";
import { metadataRevision } from "@/lib/metadata-events";

type LspPosition = { line: number; character: number };
function completionKind(kind?: number) {
  const k = monaco.languages.CompletionItemKind;
  return (
    (
      {
        1: k.Text,
        2: k.Method,
        3: k.Function,
        4: k.Constructor,
        5: k.Field,
        6: k.Variable,
        7: k.Class,
        8: k.Interface,
        9: k.Module,
        10: k.Property,
        11: k.Unit,
        12: k.Value,
        13: k.Enum,
        14: k.Keyword,
        15: k.Snippet,
        16: k.Color,
        17: k.File,
        18: k.Reference,
        19: k.Folder,
        20: k.EnumMember,
        21: k.Constant,
        22: k.Struct,
        23: k.Event,
        24: k.Operator,
        25: k.TypeParameter,
      } as Record<number, monaco.languages.CompletionItemKind>
    )[kind ?? 1] ?? k.Text
  );
}
type LspItem = {
  label: string | { label: string };
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: {
    newText: string;
    range: { start: LspPosition; end: LspPosition };
  };
  filterText?: string;
  sortText?: string;
};
interface Response {
  result: unknown;
}
interface Diagnostic {
  range: { start: LspPosition; end: LspPosition };
  message: string;
  severity?: number;
}
const metadata = new Map<
  string,
  { loaded: number; data: DataTable; revision: number }
>();
let component: { checked: number; available: boolean } | null = null;
// After a failure or a timeout (up to 25 s), the catalog answers for a while
// instead of every keystroke waiting on the service again.
let serviceFailedAt = 0;
const SERVICE_RETRY_MS = 30000;
export let languageStatus = "Checking language services…";
export function invalidateMetadata() {
  metadata.clear();
  component = null;
}
async function cached(
  context: Context,
  resource: Parameters<typeof management.read>[1],
) {
  const key = JSON.stringify([context, resource]),
    old = metadata.get(key);
  if (
    old &&
    old.revision === metadataRevision() &&
    Date.now() - old.loaded < 60000
  )
    return old.data;
  const data = await management.read(context, resource);
  metadata.set(key, { loaded: Date.now(), data, revision: metadataRevision() });
  return data;
}
// The editor opens each tab's model at Uri.parse(tab id), which reads the
// bare id as a path: the model's URI is file:///<id>, not the id itself.
function contextForModel(model: monaco.editor.ITextModel) {
  const uri = model.uri.toString();
  return useQueries
    .getState()
    .tabs.find((t) => monaco.Uri.parse(t.id).toString() === uri);
}
function range(value: { start: LspPosition; end: LspPosition }) {
  return {
    startLineNumber: value.start.line + 1,
    startColumn: value.start.character + 1,
    endLineNumber: value.end.line + 1,
    endColumn: value.end.character + 1,
  };
}
async function request(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  method: string,
): Promise<Response | null> {
  const tab = contextForModel(model);
  if (
    !tab?.database ||
    tab.sqlcmdMode ||
    tab.metadataAvailable === false ||
    tab.status === "disconnected"
  )
    return null;
  if (!component || Date.now() - component.checked > 5000) {
    const list = await management.dependencies();
    component = {
      checked: Date.now(),
      available: list.some(
        (d) => d.name === "SQL Tools Service" && d.available,
      ),
    };
  }
  if (!component.available) {
    languageStatus =
      "Catalog completion · configure SQL Tools Service for semantic IntelliSense";
    return null;
  }
  if (Date.now() - serviceFailedAt < SERVICE_RETRY_MS) return null;
  try {
    const value = await invoke<Response>("language_request", {
      tabId: tab.id,
      id: tab.connectionId,
      database: tab.database,
      text: model.getValue(),
      line: position.lineNumber - 1,
      character: position.column - 1,
      method,
      metadataRevision: metadataRevision(),
    });
    languageStatus = "SQL Tools Service connected";
    return value;
  } catch {
    serviceFailedAt = Date.now();
    languageStatus = "Language service unavailable · using catalog completion";
    return null;
  }
}

function catalogObjects(table: DataTable): CatalogObject[] {
  return records(table)
    .filter((o) => o.name && COMPLETABLE_TYPES.has(o.type_desc ?? ""))
    .map((o) => ({
      schema: o.schema ?? "dbo",
      name: o.name ?? "",
      objectId: Number(o.object_id),
      type: o.type_desc ?? "",
    }));
}

const objectKind = (type: string) =>
  type.includes("PROCEDURE")
    ? monaco.languages.CompletionItemKind.Method
    : type.includes("FUNCTION")
      ? monaco.languages.CompletionItemKind.Function
      : type === "VIEW"
        ? monaco.languages.CompletionItemKind.Interface
        : monaco.languages.CompletionItemKind.Class;

// Columns first, then variables, objects, keywords, functions and snippets;
// Monaco ranks by how well each matches what is typed before this order.
const ORDER = { column: "0", variable: "1", object: "2", keyword: "3", function: "4", snippet: "5" };

/** Whether the cursor follows "x." or "@", where only members or variables belong. */
function member(model: monaco.editor.ITextModel, position: monaco.Position) {
  const before = model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  return qualifierBefore(before) !== null || /@[\w@$#]*$/.test(before);
}

async function columnsOf(context: Context, object: CatalogObject) {
  return records(
    await cached(context, { kind: "columns", objectId: object.objectId }),
  );
}

/**
 * Suggestions from the catalog, for when SQL Tools Service is not there:
 * after "x." the columns of the table or alias x, or the objects of schema
 * x; after "@" the script's variables; otherwise the columns of the
 * statement's tables, the database's objects, T-SQL keywords and functions.
 * `member` is true when only those members belong in the list.
 */
// SQL Tools Service publishes a tab's errors once it has checked its latest
// text, a moment after the edit; they go on the editor as they come.
void listen<{ tabId: string; diagnostics: Diagnostic[] }>(
  "language-diagnostics",
  ({ payload }) => {
    const model = monaco.editor.getModel(monaco.Uri.parse(payload.tabId));
    if (!model || model.isDisposed()) return;
    monaco.editor.setModelMarkers(
      model,
      "sqltools",
      payload.diagnostics.map((d) => ({
        ...range(d.range),
        message: d.message,
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  },
).catch(() => {});

async function catalogSuggestions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  replace: monaco.IRange,
): Promise<{ items: monaco.languages.CompletionItem[]; member: boolean }> {
  const text = model.getValue();
  const offset = model.getOffsetAt(position);
  const before = text.slice(0, offset);
  // Monaco's SQL words stop at "@", so a variable's range starts at its "@".
  const variable = /@[\w@$#]*$/.exec(before);
  if (variable && !variable[0].startsWith("@@")) {
    const start = model.getPositionAt(offset - variable[0].length);
    const range = new monaco.Range(start.lineNumber, start.column, position.lineNumber, position.column);
    return {
      member: true,
      items: declaredVariables(text).map((name) => ({
        label: name,
        kind: monaco.languages.CompletionItemKind.Variable,
        insertText: name,
        sortText: ORDER.variable,
        range,
      })),
    };
  }

  const tab = contextForModel(model);
  if (!tab?.database || tab.metadataAvailable === false) return { items: [], member: false };
  const context = { connectionId: tab.connectionId, database: tab.database };
  const objects = catalogObjects(await cached(context, { kind: "objects" }));
  const statement = statementAround(text, offset);
  // The statement's own names first, so its alias wins over one elsewhere.
  const references = [...tableReferences(statement), ...tableReferences(text)];

  const qualifier = qualifierBefore(before);
  if (qualifier !== null) {
    const target = resolveQualifier(qualifier, references, objects);
    if (target && "columnsOf" in target)
      return {
        member: true,
        items: (await columnsOf(context, target.columnsOf)).map((c) => ({
          label: c.name ?? "",
          kind: monaco.languages.CompletionItemKind.Field,
          detail: `${c.type}${c.is_nullable === "1" ? " null" : " not null"}`,
          insertText: identifier(c.name ?? ""),
          sortText: ORDER.column,
          range: replace,
        })),
      };
    if (target)
      return {
        member: true,
        items: objects
          .filter((o) => o.schema.toLowerCase() === target.schema.toLowerCase())
          .map((o) => ({
            label: o.name,
            kind: objectKind(o.type),
            detail: o.type,
            insertText: identifier(o.name),
            sortText: ORDER.object,
            range: replace,
          })),
      };
    return { items: [], member: true };
  }

  // The columns of the tables this statement names, each with its table.
  const tables = new Map<number, CatalogObject>();
  for (const r of tableReferences(statement)) {
    const object = findObject(objects, r.name, r.schema);
    if (object) tables.set(object.objectId, object);
  }
  const columns = (
    await Promise.all(
      [...tables.values()].map(async (table) =>
        (await columnsOf(context, table)).map((c) => ({
          label: { label: c.name ?? "", description: `${table.schema}.${table.name}` },
          kind: monaco.languages.CompletionItemKind.Field,
          detail: `${c.type}${c.is_nullable === "1" ? " null" : " not null"}`,
          insertText: identifier(c.name ?? ""),
          sortText: ORDER.column,
          range: replace,
        })),
      ),
    )
  ).flat();
  return {
    member: false,
    items: [
      ...columns,
      ...objects.map((o) => ({
        label: `${o.schema}.${o.name}`,
        kind: objectKind(o.type),
        detail: o.type,
        // Found by its name alone too, not only from its schema.
        filterText: `${o.schema}.${o.name} ${o.name}`,
        insertText: `${identifier(o.schema)}.${identifier(o.name)}`,
        sortText: ORDER.object,
        range: replace,
      })),
      ...KEYWORDS.map((k) => ({
        label: k,
        kind: monaco.languages.CompletionItemKind.Keyword,
        insertText: k,
        sortText: ORDER.keyword,
        range: replace,
      })),
      ...FUNCTIONS.map((f) => ({
        label: f,
        kind: monaco.languages.CompletionItemKind.Function,
        detail: "built-in function",
        insertText: f,
        sortText: ORDER.function,
        range: replace,
      })),
    ],
  };
}

monaco.languages.registerCompletionItemProvider("sql", {
  triggerCharacters: [".", "@"],
  async provideCompletionItems(model, position, _context, token) {
    const word = model.getWordUntilPosition(position),
      replace = new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      );
    const snippets: monaco.languages.CompletionItem[] = useTemplates
      .getState()
      .templates.filter((t) => t.snippet)
      .map((t) => ({
        label: t.name,
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: t.description,
        sortText: ORDER.snippet,
        insertText: t.body,
        insertTextRules:
          monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range: replace,
      }));
    try {
      const response = await request(model, position, "completion");
      if (token.isCancellationRequested) return { suggestions: [] };
      const result = response?.result as
        | { items?: LspItem[] }
        | LspItem[]
        | null;
      const items = Array.isArray(result) ? result : result?.items;
      if (items?.length)
        return {
          suggestions: [
            ...items.map((item) => ({
              label: item.label,
              kind: completionKind(item.kind),
              detail: item.detail,
              documentation:
                typeof item.documentation === "string"
                  ? item.documentation
                  : item.documentation
                    ? { value: item.documentation.value }
                    : undefined,
              insertText:
                item.textEdit?.newText ??
                item.insertText ??
                (typeof item.label === "string"
                  ? item.label
                  : item.label.label),
              insertTextRules:
                item.insertTextFormat === 2
                  ? monaco.languages.CompletionItemInsertTextRule
                      .InsertAsSnippet
                  : undefined,
              range: item.textEdit ? range(item.textEdit.range) : replace,
              filterText: item.filterText,
              // Ahead of the snippets, in the service's own order.
              sortText: ORDER.column + (item.sortText ?? ""),
            })),
            ...(member(model, position) ? [] : snippets),
          ],
        };
      const catalog = await catalogSuggestions(model, position, replace);
      // After "x." or "@" only members and variables belong in the list.
      return {
        suggestions: catalog.member
          ? catalog.items
          : [...catalog.items, ...snippets],
      };
    } catch {
      return { suggestions: snippets };
    }
  },
});
monaco.languages.registerHoverProvider("sql", {
  async provideHover(model, position) {
    const response = await request(model, position, "hover");
    const value = response?.result as {
      contents?:
        | (string | { value: string; language?: string })[]
        | string
        | { value: string; language?: string };
    } | null;
    if (!value?.contents) return null;
    const contents = Array.isArray(value.contents)
      ? value.contents
      : [value.contents];
    // LSP MarkedStrings carry their language apart: a code block in Markdown.
    return {
      contents: contents.map((c) =>
        typeof c === "string"
          ? { value: c }
          : c.language
            ? { value: "```" + c.language + "\n" + c.value + "\n```" }
            : { value: c.value },
      ),
    };
  },
});
monaco.languages.registerSignatureHelpProvider("sql", {
  signatureHelpTriggerCharacters: ["(", ","],
  async provideSignatureHelp(model, position) {
    const response = await request(model, position, "signature");
    if (!response?.result) return null;
    return {
      value: response.result as monaco.languages.SignatureHelp,
      dispose() {},
    };
  },
});
export function syncLanguage(model: monaco.editor.ITextModel) {
  const end = model.getFullModelRange();
  void request(
    model,
    new monaco.Position(end.endLineNumber, end.endColumn),
    "sync",
  ).catch(() => {});
}
