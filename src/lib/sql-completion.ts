// What the catalog IntelliSense reads from the script around the cursor:
// the qualifier before a ".", the tables a statement names and their
// aliases, the variables it declares, and the T-SQL words to offer. Plain
// text in and out, so it is tested without Monaco or a server
// (sql-completion.test.ts); src/lib/intellisense.ts turns it into suggestions.

/** sys.objects types a script names: not constraints, triggers or internal tables. */
export const COMPLETABLE_TYPES = new Set([
  "USER_TABLE",
  "VIEW",
  "SQL_STORED_PROCEDURE",
  "CLR_STORED_PROCEDURE",
  "EXTENDED_STORED_PROCEDURE",
  "SQL_SCALAR_FUNCTION",
  "SQL_TABLE_VALUED_FUNCTION",
  "SQL_INLINE_TABLE_VALUED_FUNCTION",
  "CLR_SCALAR_FUNCTION",
  "CLR_TABLE_VALUED_FUNCTION",
  "AGGREGATE_FUNCTION",
  "SYNONYM",
  "SEQUENCE_OBJECT",
]);

export const KEYWORDS = [
  "ADD", "ALL", "ALTER", "AND", "ANY", "AS", "ASC", "BACKUP", "BEGIN", "BETWEEN", "BREAK", "BY",
  "CASCADE", "CASE", "CATCH", "CHECK", "CHECKPOINT", "CLOSE", "CLUSTERED", "COLLATE", "COLUMN", "COMMIT",
  "CONSTRAINT", "CONTINUE", "CREATE", "CROSS", "CURSOR", "DATABASE", "DEALLOCATE", "DECLARE", "DEFAULT",
  "DELETE", "DENY", "DESC", "DISTINCT", "DROP", "ELSE", "END", "ESCAPE", "EXCEPT", "EXEC", "EXECUTE",
  "EXISTS", "FETCH", "FOR", "FOREIGN", "FROM", "FULL", "FUNCTION", "GO", "GOTO", "GRANT", "GROUP",
  "HAVING", "IDENTITY", "IF", "IN", "INDEX", "INNER", "INSERT", "INTERSECT", "INTO", "IS", "JOIN",
  "KEY", "LEFT", "LIKE", "MERGE", "NEXT", "NOCOUNT", "NONCLUSTERED", "NOT", "NULL", "OF", "OFF",
  "OFFSET", "ON", "ONLY", "OPEN", "OPTION", "OR", "ORDER", "OUTER", "OUTPUT", "OVER", "PARTITION",
  "PERCENT", "PIVOT", "PRIMARY", "PRINT", "PROCEDURE", "RAISERROR", "REFERENCES", "RESTORE",
  "RETURN", "RETURNS", "REVOKE", "RIGHT", "ROLLBACK", "ROWS", "SAVE", "SCHEMA", "SELECT", "SET",
  "TABLE", "THEN", "THROW", "TIES", "TOP", "TRAN", "TRANSACTION", "TRIGGER", "TRUNCATE", "TRY",
  "UNION", "UNIQUE", "UNPIVOT", "UPDATE", "USE", "USING", "VALUES", "VIEW", "WAITFOR", "WHEN",
  "WHERE", "WHILE", "WITH", "XACT_ABORT",
];

export const FUNCTIONS = [
  "ABS", "AVG", "CAST", "CEILING", "CHARINDEX", "CHECKSUM", "COALESCE", "CONCAT", "CONCAT_WS", "CONVERT",
  "COUNT", "COUNT_BIG", "CUME_DIST", "DATALENGTH", "DATEADD", "DATEDIFF", "DATEFROMPARTS", "DATENAME",
  "DATEPART", "DATETRUNC", "DAY", "DB_ID", "DB_NAME", "DENSE_RANK", "EOMONTH", "ERROR_LINE",
  "ERROR_MESSAGE", "ERROR_NUMBER", "ERROR_PROCEDURE", "ERROR_SEVERITY", "ERROR_STATE", "FIRST_VALUE",
  "FLOOR", "FORMAT", "GETDATE", "GETUTCDATE", "GREATEST", "IIF", "ISJSON", "ISNULL", "ISNUMERIC",
  "JSON_QUERY", "JSON_VALUE", "LAG", "LAST_VALUE", "LEAD", "LEAST", "LEFT", "LEN", "LOWER", "LTRIM",
  "MAX", "MIN", "MONTH", "NEWID", "NTILE", "NULLIF", "OBJECT_ID", "OBJECT_NAME", "OPENJSON",
  "PATINDEX", "POWER", "QUOTENAME", "RANK", "REPLACE", "REPLICATE", "REVERSE", "RIGHT", "ROUND",
  "ROW_NUMBER", "RTRIM", "SCHEMA_NAME", "SCOPE_IDENTITY", "SIGN", "SPACE", "SQRT", "STRING_AGG",
  "STRING_SPLIT", "STUFF", "SUBSTRING", "SUM", "SUSER_SNAME", "SYSDATETIME", "SYSDATETIMEOFFSET",
  "SYSUTCDATETIME", "TRANSLATE", "TRIM", "TRY_CAST", "TRY_CONVERT", "TRY_PARSE", "UPPER", "YEAR",
];

const RESERVED = new Set(KEYWORDS);

/** A name as T-SQL needs it: plain when it is a regular identifier, else in brackets. */
export function identifier(name: string) {
  return /^[A-Za-z_][\w@$#]*$/.test(name) && !RESERVED.has(name.toUpperCase())
    ? name
    : `[${name.split("]").join("]]")}]`;
}

// One part of a name: [any text] or a regular identifier.
const PART = String.raw`(?:\[((?:[^\]]|\]\])+)\]|([A-Za-z_@#][\w@$#]*))`;
const unbracket = (bracketed?: string, plain?: string) => (bracketed?.replace(/\]\]/g, "]") ?? plain ?? "");

/**
 * The name before the "." the cursor follows, with the part being typed
 * after it: `c.Na`, `[Order Details].`, `dbo.[Cu`. For `db.dbo.` it is
 * the schema, the part next to the dot.
 */
export function qualifierBefore(before: string): string | null {
  const match = new RegExp(`${PART}\\.(?:\\[[^\\]]*|[\\w@$#]*)$`).exec(before);
  return match ? unbracket(match[1], match[2]) : null;
}

export interface TableReference {
  schema: string | null;
  name: string;
  alias: string | null;
}

// Words that can follow a table name and are not its alias.
const NOT_ALIAS = new Set([
  "WHERE", "ON", "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER", "APPLY", "GROUP", "ORDER",
  "SET", "WITH", "UNION", "EXCEPT", "INTERSECT", "HAVING", "VALUES", "OUTPUT", "SELECT", "OPTION",
  "WHEN", "USING", "GO", "INSERT", "UPDATE", "DELETE", "MERGE", "DEFAULT", "EXEC", "EXECUTE", "PIVOT",
  "UNPIVOT", "FOR", "TABLESAMPLE", "BEGIN", "END", "IF", "ELSE", "DECLARE", "RETURN", "AND", "OR",
]);

/** The tables and views a script names after FROM, JOIN, UPDATE, INTO and MERGE, with their aliases. */
export function tableReferences(text: string): TableReference[] {
  const pattern = new RegExp(
    String.raw`\b(?:FROM|JOIN|UPDATE|INTO|MERGE(?:\s+INTO)?|USING)\s+` +
      `${PART}(?:\\s*\\.\\s*${PART})?(?:\\s*\\.\\s*${PART})?` +
      String.raw`(?:\s+(?:AS\s+)?` + PART + ")?",
    "gi",
  );
  const references: TableReference[] = [];
  for (const m of text.matchAll(pattern)) {
    const parts = [unbracket(m[1], m[2]), unbracket(m[3], m[4]), unbracket(m[5], m[6])].filter(Boolean);
    // db.schema.name, schema.name or name.
    const name = parts[parts.length - 1];
    const schema = parts.length > 1 ? parts[parts.length - 2] : null;
    const aliasText = unbracket(m[7], m[8]);
    const alias = aliasText && !(m[8] && NOT_ALIAS.has(aliasText.toUpperCase())) ? aliasText : null;
    if (name.startsWith("@") || name.startsWith("#")) continue;
    references.push({ schema, name, alias });
  }
  return references;
}

export interface CatalogObject {
  schema: string;
  name: string;
  objectId: number;
  type: string;
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** The object a reference names: by schema when it gives one, else dbo first. */
export function findObject(objects: CatalogObject[], name: string, schema: string | null) {
  const named = objects.filter((o) => same(o.name, name));
  if (schema) return named.find((o) => same(o.schema, schema));
  return named.find((o) => same(o.schema, "dbo")) ?? named[0];
}

/**
 * What a qualifier stands for: an alias or a table named in the script,
 * whose columns follow the dot, or a schema, whose objects do.
 */
export function resolveQualifier(
  qualifier: string,
  references: TableReference[],
  objects: CatalogObject[],
): { columnsOf: CatalogObject } | { schema: string } | null {
  const reference =
    references.find((r) => same(r.alias, qualifier)) ??
    references.find((r) => !r.alias && same(r.name, qualifier));
  const object = reference
    ? findObject(objects, reference.name, reference.schema)
    : findObject(objects, qualifier, null);
  if (object) return { columnsOf: object };
  if (objects.some((o) => same(o.schema, qualifier))) return { schema: qualifier };
  return null;
}

/** The variables and parameters a script declares, as written: @Id, @from. */
export function declaredVariables(text: string): string[] {
  const names = new Map<string, string>();
  for (const m of text.matchAll(/(?<![@\w])@(?!@)([A-Za-z_][\w@$#]*)/g)) {
    const key = m[1].toLowerCase();
    if (!names.has(key)) names.set(key, `@${m[1]}`);
  }
  return [...names.values()];
}

/** The statement the cursor is in: from the last GO or semicolon before it to the next one after. */
export function statementAround(text: string, offset: number): string {
  const separator = /;|^\s*GO\s*$/gim;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(separator)) {
    const at = m.index ?? 0;
    if (at + m[0].length <= offset) start = at + m[0].length;
    else if (at >= offset) {
      end = at;
      break;
    }
  }
  return text.slice(start, end);
}
