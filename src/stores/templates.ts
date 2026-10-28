import { create } from "zustand";
export interface SqlTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  body: string;
  snippet: boolean;
}
export const BUILTIN_TEMPLATES: SqlTemplate[] = [
  {
    id: "database-trigger",
    name: "Create database DDL trigger",
    category: "Programmability",
    description: "Database-scoped DDL trigger",
    body: "CREATE TRIGGER ${1:TriggerName} ON DATABASE\nFOR ${2:CREATE_TABLE}\nAS\nBEGIN\n  ${3:PRINT 'Table created';}\nEND;\nGO",
    snippet: true,
  },
  {
    id: "select",
    name: "Select rows",
    category: "Queries",
    description: "Bounded SELECT",
    body: "SELECT TOP (${1:1000}) ${2:*}\nFROM ${3:dbo.TableName}\nWHERE ${4:1 = 1};",
    snippet: true,
  },
  {
    id: "transaction",
    name: "Transaction with error handling",
    category: "Transactions",
    description: "Rollback on error",
    body: "SET XACT_ABORT ON;\nBEGIN TRY\n  BEGIN TRANSACTION;\n  ${1:-- Statements}\n  COMMIT TRANSACTION;\nEND TRY\nBEGIN CATCH\n  IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\n  THROW;\nEND CATCH;",
    snippet: true,
  },
  {
    id: "procedure",
    name: "Create stored procedure",
    category: "Programmability",
    description: "SQL Server 2012-compatible procedure",
    body: "CREATE PROCEDURE ${1:dbo.ProcedureName}\n  @${2:Id} int\nAS\nBEGIN\n  SET NOCOUNT ON;\n  ${3:SELECT @Id;}\nEND;\nGO",
    snippet: true,
  },
  {
    id: "trigger",
    name: "Create table trigger",
    category: "Programmability",
    description: "Set-based trigger",
    body: "CREATE TRIGGER ${1:dbo.TriggerName} ON ${2:dbo.TableName}\nAFTER INSERT, UPDATE\nAS\nBEGIN\n  SET NOCOUNT ON;\n  ${3:-- Use the inserted and deleted tables.}\nEND;\nGO",
    snippet: true,
  },
  {
    id: "function",
    name: "Create inline table-valued function",
    category: "Programmability",
    description: "Inline table-valued function",
    body: "CREATE FUNCTION ${1:dbo.FunctionName}(@${2:Id} int)\nRETURNS TABLE\nAS RETURN (\n  SELECT ${3:*} FROM ${4:dbo.TableName} WHERE ${5:Id} = @${2:Id}\n);\nGO",
    snippet: true,
  },
  {
    id: "view",
    name: "Create view",
    category: "Programmability",
    description: "View definition",
    body: "CREATE VIEW ${1:dbo.ViewName} AS\nSELECT ${2:*} FROM ${3:dbo.TableName};\nGO",
    snippet: true,
  },
  {
    id: "server-trigger",
    name: "Create server DDL trigger",
    category: "Programmability",
    description: "Server trigger template",
    body: "CREATE TRIGGER ${1:TriggerName} ON ALL SERVER\nFOR ${2:CREATE_DATABASE}\nAS\nBEGIN\n  ${3:PRINT 'Database created';}\nEND;\nGO",
    snippet: true,
  },
];
function initial(): SqlTemplate[] {
  try {
    const value = JSON.parse(
      localStorage.getItem("quervio.templates.v1") ?? "null",
    );
    return Array.isArray(value) ? validateTemplates(value) : BUILTIN_TEMPLATES;
  } catch {
    return BUILTIN_TEMPLATES;
  }
}
export function validateTemplates(value: unknown): SqlTemplate[] {
  if (
    !Array.isArray(value) ||
    value.length > 1000 ||
    value.some(
      (t) =>
        !t ||
        typeof t.id !== "string" ||
        typeof t.name !== "string" ||
        typeof t.body !== "string" ||
        typeof t.category !== "string" ||
        typeof t.description !== "string" ||
        typeof t.snippet !== "boolean" ||
        t.body.length > 1024 * 1024,
    )
  )
    throw new Error("Invalid template collection.");
  if (new Set(value.map((t) => t.id)).size !== value.length)
    throw new Error("Template IDs must be unique.");
  return value;
}
export const useTemplates = create<{
  templates: SqlTemplate[];
  save: (template: SqlTemplate) => void;
  remove: (id: string) => void;
  replace: (templates: SqlTemplate[]) => void;
}>((set, get) => {
  function replace(templates: SqlTemplate[]) {
    const validated = validateTemplates(templates);
    localStorage.setItem("quervio.templates.v1", JSON.stringify(validated));
    set({ templates: validated });
  }
  return {
    templates: initial(),
    save: (template) =>
      replace([
        ...get().templates.filter((t) => t.id !== template.id),
        template,
      ]),
    remove: (id) => replace(get().templates.filter((t) => t.id !== id)),
    replace,
  };
});
