import { invoke } from "@tauri-apps/api/core";
import { monaco } from "@/lib/monaco";
import {
  management,
  records,
  quoteName,
  type Context,
  type DataTable,
} from "@/lib/management-api";
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
  diagnostics: {
    range: { start: LspPosition; end: LspPosition };
    message: string;
    severity?: number;
  }[];
}
const metadata = new Map<
  string,
  { loaded: number; data: DataTable; revision: number }
>();
let component: { checked: number; available: boolean } | null = null;
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
function contextForModel(model: monaco.editor.ITextModel) {
  return useQueries.getState().tabs.find((t) => t.id === model.uri.toString());
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
  const version = model.getVersionId();
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
    if (!model.isDisposed() && model.getVersionId() === version)
      monaco.editor.setModelMarkers(
        model,
        "sqltools",
        value.diagnostics.map((d) => ({
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
    languageStatus = "SQL Tools Service connected";
    return value;
  } catch {
    languageStatus = "Language service unavailable · using catalog completion";
    return null;
  }
}

async function catalogSuggestions(
  model: monaco.editor.ITextModel,
  position: monaco.Position,
  replace: monaco.IRange,
): Promise<monaco.languages.CompletionItem[]> {
  const tab = contextForModel(model);
  if (!tab?.database || tab.metadataAvailable === false) return [];
  const context = { connectionId: tab.connectionId, database: tab.database };
  const objects = records(await cached(context, { kind: "objects" }));
  const before = model.getValueInRange({
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
  const qualifier = /([\w\[\]]+)\.\w*$/
    .exec(before)?.[1]
    ?.replace(/[\[\]]/g, "");
  if (qualifier) {
    const references = [
      ...model
        .getValue()
        .matchAll(
          /\b(?:FROM|JOIN|UPDATE|INTO)\s+(?:\[([^\]]+)\]|(\w+))(?:\.(?:\[([^\]]+)\]|(\w+)))?(?:\s+(?:AS\s+)?(\w+))?/gi,
        ),
    ];
    const reference = references.find(
      (m) =>
        (m[5] ?? m[3] ?? m[4] ?? m[1] ?? m[2]).toLowerCase() ===
        qualifier.toLowerCase(),
    );
    const name = reference
      ? (reference[3] ?? reference[4] ?? reference[1] ?? reference[2])
      : qualifier;
    const schema =
      reference && (reference[3] || reference[4])
        ? (reference[1] ?? reference[2])
        : null;
    const object = objects.find(
      (o) =>
        o.name?.toLowerCase() === name.toLowerCase() &&
        (!schema || o.schema?.toLowerCase() === schema.toLowerCase()),
    );
    if (object?.object_id)
      return records(
        await cached(context, {
          kind: "columns",
          objectId: Number(object.object_id),
        }),
      ).map((c) => ({
        label: c.name ?? "",
        kind: monaco.languages.CompletionItemKind.Field,
        detail: `${c.type}${c.is_nullable === "1" ? " null" : " not null"}`,
        insertText: quoteName(c.name ?? ""),
        range: replace,
      }));
    return objects
      .filter((o) => o.schema?.toLowerCase() === qualifier.toLowerCase())
      .map((o) => ({
        label: o.name ?? "",
        kind: monaco.languages.CompletionItemKind.Class,
        detail: o.type_desc ?? "",
        insertText: quoteName(o.name ?? ""),
        range: replace,
      }));
  }
  return objects.map((o) => ({
    label: `${o.schema}.${o.name}`,
    kind:
      o.type_desc === "SQL_STORED_PROCEDURE"
        ? monaco.languages.CompletionItemKind.Function
        : monaco.languages.CompletionItemKind.Class,
    detail: o.type_desc ?? "",
    insertText: `${quoteName(o.schema ?? "dbo")}.${quoteName(o.name ?? "")}`,
    range: replace,
  }));
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
              sortText: item.sortText,
            })),
            ...snippets,
          ],
        };
      return {
        suggestions: [
          ...(await catalogSuggestions(model, position, replace)),
          ...snippets,
        ],
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
      contents?: (string | { value: string })[] | string | { value: string };
    } | null;
    if (!value?.contents) return null;
    const contents = Array.isArray(value.contents)
      ? value.contents
      : [value.contents];
    return {
      contents: contents.map((c) => (typeof c === "string" ? { value: c } : c)),
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
