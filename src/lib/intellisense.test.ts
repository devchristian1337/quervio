import { beforeEach, describe, expect, it, vi } from "vitest";

const registeredProviders: {
  provideCompletionItems: (
    model: unknown,
    position: { lineNumber: number; column: number },
    context: unknown,
    token: { isCancellationRequested: boolean },
  ) => Promise<{
    suggestions: {
      label: unknown;
      insertText: string;
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
    }[];
  }>;
}[] = [];

const readMock = vi.fn(async () => ({
  columns: ["schema", "name", "object_id", "type_desc"],
  rows: [
    ["dbo", "Order Details", "1", "USER_TABLE"],
    ["dbo", "Orders", "2", "USER_TABLE"],
  ],
  truncated: false,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/monaco", () => ({
  monaco: {
    Uri: { parse: (s: string) => ({ toString: () => `file:///${s}` }) },
    Range: class {
      constructor(
        public startLineNumber: number,
        public startColumn: number,
        public endLineNumber: number,
        public endColumn: number,
      ) {}
    },
    Position: class {
      constructor(
        public lineNumber: number,
        public column: number,
      ) {}
    },
    languages: {
      CompletionItemKind: {
        Text: 1, Method: 2, Function: 3, Constructor: 4, Field: 5, Variable: 6, Class: 7,
        Interface: 8, Module: 9, Property: 10, Unit: 11, Value: 12, Enum: 13, Keyword: 14,
        Snippet: 15, Color: 16, File: 17, Reference: 18, Folder: 19, EnumMember: 20,
        Constant: 21, Struct: 22, Event: 23, Operator: 24, TypeParameter: 25,
      },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
      registerCompletionItemProvider: (_lang: string, provider: (typeof registeredProviders)[number]) => {
        registeredProviders.push(provider);
      },
      registerHoverProvider: vi.fn(),
      registerSignatureHelpProvider: vi.fn(),
    },
    editor: {
      getModel: vi.fn(),
      setModelMarkers: vi.fn(),
    },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
  },
}));
vi.mock("@/lib/management-api", () => ({
  management: {
    dependencies: vi.fn(async () => [{ name: "SQL Tools Service", available: false, path: null, help: "" }]),
    read: readMock,
  },
  records: (t: { columns: string[]; rows: (string | null)[][] }) =>
    t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]]))),
}));
vi.mock("@/stores/queries", () => ({
  useQueries: {
    getState: () => ({
      tabs: [{ id: "tab-1", connectionId: "c1", database: "Sales", status: "ready", sqlcmdMode: false }],
    }),
  },
}));
vi.mock("@/stores/templates", () => ({
  useTemplates: { getState: () => ({ templates: [] }) },
}));

const { invalidateMetadata } = await import("@/lib/intellisense");

beforeEach(() => {
  vi.clearAllMocks();
  invalidateMetadata();
});

describe("intellisense bracketed member completion", () => {
  it("replaces the opening '[' after a dot without doubling or leaving brackets unclosed", async () => {
    const provider = registeredProviders[0];
    const text = "SELECT * FROM dbo.[Ord";
    const position = { lineNumber: 1, column: text.length + 1 };
    const model = {
      uri: { toString: () => "file:///tab-1" },
      getValue: () => text,
      getOffsetAt: () => text.length,
      getWordUntilPosition: () => ({ word: "Ord", startColumn: 20, endColumn: 23 }),
      getValueInRange: () => text,
    };

    const result = await provider.provideCompletionItems(model, position, {}, { isCancellationRequested: false });
    const apply = (item: (typeof result.suggestions)[number]) =>
      text.slice(0, item.range.startColumn - 1) + item.insertText + text.slice(item.range.endColumn - 1);

    const orderDetails = result.suggestions.find((s) => s.label === "Order Details")!;
    const orders = result.suggestions.find((s) => s.label === "Orders")!;
    expect(apply(orderDetails)).toBe("SELECT * FROM dbo.[Order Details]");
    expect(apply(orders)).toBe("SELECT * FROM dbo.Orders");
  });

  it("also absorbs an auto-closed ']' immediately following the cursor", async () => {
    const provider = registeredProviders[0];
    const text = "SELECT * FROM dbo.[Ord]";
    const offset = text.length - 1;
    const position = { lineNumber: 1, column: offset + 1 };
    const model = {
      uri: { toString: () => "file:///tab-1" },
      getValue: () => text,
      getOffsetAt: () => offset,
      getWordUntilPosition: () => ({ word: "Ord", startColumn: 20, endColumn: 23 }),
      getValueInRange: () => text.slice(0, offset),
    };

    const result = await provider.provideCompletionItems(model, position, {}, { isCancellationRequested: false });
    const apply = (item: (typeof result.suggestions)[number]) =>
      text.slice(0, item.range.startColumn - 1) + item.insertText + text.slice(item.range.endColumn - 1);

    const orderDetails = result.suggestions.find((s) => s.label === "Order Details")!;
    expect(apply(orderDetails)).toBe("SELECT * FROM dbo.[Order Details]");
  });
});
