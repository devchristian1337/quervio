import { useEffect, useState, useRef } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "@/lib/api";
import {
  management,
  records,
  qualifiedName as q,
  quoteName as n,
  sqlLiteral as l,
  type Context,
} from "@/lib/management-api";
import {
  foreignKeyScript,
  tableScript,
  type ColumnDefinition,
  type TableDefinition,
} from "@/lib/sql-management";
import type { ToolTab } from "@/stores/workbench";
import {useQueries} from "@/stores/queries";
import { Button } from "@/components/ui/button";
import {
  Choice,
  DataGrid,
  Field,
  inputClass,
  Notice,
  Operation,
  ReadTable,
  Text,
  useRead,
} from "./shared";

const emptyColumn = (): ColumnDefinition => ({
  name: "",
  type: "nvarchar(100)",
  nullable: true,
  identity: false,
  seed: "1",
  increment: "1",
  computed: "",
  defaultValue: "",
});
function buildType(row: Record<string, string | null>) {
  const type = row.type ?? "int",
    length = Number(row.max_length);
  if (
    ["nvarchar", "nchar", "varchar", "char", "binary", "varbinary"].includes(
      type,
    )
  )
    return `${type}(${length === -1 ? "max" : type.startsWith("n") ? length / 2 : length})`;
  if (["decimal", "numeric"].includes(type))
    return `${type}(${row.precision},${row.scale})`;
  if (["datetime2", "datetimeoffset", "time"].includes(type))
    return `${type}(${row.scale})`;
  return type;
}

export function TableDesigner({ tab }: { tab: ToolTab }) {
  const [model, setModel] = useState<TableDefinition>({
    schema: tab.schema ?? "dbo",
    name: tab.name ?? "",
    columns: [emptyColumn()],
    primaryKey: [],
  });
  const [original, setOriginal] = useState<TableDefinition | undefined>(),
    [error, setError] = useState<string | null>(null),
    [loaded, setLoaded] = useState(!tab.objectId);
  const [constraint, setConstraint] = useState("INDEX"),
    [constraintName, setConstraintName] = useState(""),
    [constraintColumns, setConstraintColumns] = useState(""),
    [expression, setExpression] = useState("");
  useEffect(() => {
    if (!tab.objectId) return;
    let disposed = false;
    void management.read(tab, { kind: "columns", objectId: tab.objectId }).then(
      (result) => {
        if (disposed) return;
        const value: TableDefinition = {
          schema: tab.schema ?? "dbo",
          name: tab.name ?? "",
          primaryKey: [],
          columns: records(result).map((row) => ({
            name: row.name ?? "",
            originalName: row.name ?? "",
            type: buildType(row),
            nullable: row.is_nullable === "1",
            identity: row.is_identity === "1",
            seed: row.identity_seed ?? "1",
            increment: row.identity_increment ?? "1",
            computed: row.computed_expression ?? "",
            defaultValue: row.default_expression ?? "",
            defaultName: row.default_name ?? undefined,
          })),
        };
        setModel(value);
        setOriginal(structuredClone(value));
        setLoaded(true);
      },
      (e) => !disposed && setError(errorMessage(e)),
    );
    return () => {
      disposed = true;
    };
  }, [tab.objectId, tab.connectionId, tab.database, tab.schema, tab.name]);
  function change(index: number, patch: Partial<ColumnDefinition>) {
    setModel((value) => ({
      ...value,
      columns: value.columns.map((c, i) =>
        i === index ? { ...c, ...patch } : c,
      ),
    }));
  }
  let script = "",
    validation = "";
  try {
    if (model.name && model.columns.every((c) => c.name))
      script = tableScript(model, original);
  } catch (e) {
    validation = errorMessage(e);
  }
  let constraintScript = "";
  if (
    model.name &&
    constraintName &&
    (constraintColumns || (constraint === "CHECK" && expression))
  ) {
    const columns = constraintColumns
      .split(",")
      .map((c) => n(c.trim()))
      .join(", ");
    constraintScript =
      constraint === "INDEX"
        ? `CREATE INDEX ${n(constraintName)} ON ${q(model.schema, model.name)} (${columns});`
        : constraint === "DROP"
          ? `ALTER TABLE ${q(model.schema, model.name)} DROP CONSTRAINT ${n(constraintName)};`
          : `ALTER TABLE ${q(model.schema, model.name)} ADD CONSTRAINT ${n(constraintName)} ${constraint}${constraint === "CHECK" ? ` (${expression})` : ` (${columns})`};`;
  }
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap gap-3">
        <Text
          label="Schema"
          value={model.schema}
          onChange={(schema) => setModel((m) => ({ ...m, schema }))}
        />
        <Text
          label="Table"
          value={model.name}
          onChange={(name) => setModel((m) => ({ ...m, name }))}
        />
      </div>
      {error && <Notice error>{error}</Notice>}
      {!loaded && !error && <Notice>Loading table metadata…</Notice>}
      {loaded && (
        <>
          <div className="overflow-auto rounded border">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  {[
                    "Column",
                    "SQL type",
                    "Null",
                    "Identity",
                    "Seed / increment",
                    "Computed expression",
                    "Default expression",
                    ...(!original ? ["PK"] : []),
                    "",
                  ].map((name) => (
                    <th key={name} className="px-2 py-2 text-left font-medium">
                      {name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {model.columns.map((c, i) => (
                  <tr key={i} className="border-t">
                    <td className="p-1">
                      <input
                        aria-label={`Column ${i + 1} name`}
                        className={inputClass}
                        value={c.name}
                        onChange={(e) => change(i, { name: e.target.value })}
                      />
                    </td>
                    <td className="p-1">
                      <input
                        aria-label={`Column ${i + 1} type`}
                        className={`${inputClass} w-36`}
                        value={c.type}
                        onChange={(e) => change(i, { type: e.target.value })}
                      />
                    </td>
                    <td className="p-2">
                      <input
                        aria-label={`Column ${i + 1} nullable`}
                        type="checkbox"
                        checked={c.nullable}
                        onChange={(e) =>
                          change(i, { nullable: e.target.checked })
                        }
                      />
                    </td>
                    <td className="p-2">
                      <input
                        aria-label={`Column ${i + 1} identity`}
                        type="checkbox"
                        checked={c.identity}
                        onChange={(e) =>
                          change(i, { identity: e.target.checked })
                        }
                      />
                    </td>
                    <td className="p-1">
                      <div className="flex gap-1">
                        <input
                          aria-label="Identity seed"
                          className={`${inputClass} w-14`}
                          value={c.seed}
                          onChange={(e) => change(i, { seed: e.target.value })}
                        />
                        <input
                          aria-label="Identity increment"
                          className={`${inputClass} w-14`}
                          value={c.increment}
                          onChange={(e) =>
                            change(i, { increment: e.target.value })
                          }
                        />
                      </div>
                    </td>
                    <td className="p-1">
                      <input
                        aria-label={`Column ${i + 1} computed expression`}
                        className={inputClass}
                        value={c.computed}
                        onChange={(e) =>
                          change(i, { computed: e.target.value })
                        }
                      />
                    </td>
                    <td className="p-1">
                      <input
                        aria-label={`Column ${i + 1} default`}
                        className={inputClass}
                        value={c.defaultValue}
                        onChange={(e) =>
                          change(i, { defaultValue: e.target.value })
                        }
                      />
                    </td>
                    {!original && (
                      <td className="p-2">
                        <input
                          aria-label={`Column ${i + 1} primary key`}
                          type="checkbox"
                          checked={
                            model.primaryKey.includes(c.name) && !!c.name
                          }
                          disabled={!c.name}
                          onChange={(e) =>
                            setModel((m) => ({
                              ...m,
                              primaryKey: e.target.checked
                                ? [...m.primaryKey, c.name]
                                : m.primaryKey.filter(
                                    (name) => name !== c.name,
                                  ),
                            }))
                          }
                        />
                      </td>
                    )}
                    <td className="p-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setModel((m) => ({
                            ...m,
                            columns: m.columns.filter(
                              (_, index) => index !== i,
                            ),
                          }))
                        }
                      >
                        Remove
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="self-start"
            onClick={() =>
              setModel((m) => ({
                ...m,
                columns: [...m.columns, emptyColumn()],
              }))
            }
          >
            Add column
          </Button>
          {validation && <Notice error>{validation}</Notice>}
          <Operation
            context={tab}
            script={script}
            label={original ? "Preview table changes" : "Preview CREATE TABLE"}
          />
          {original && (
            <Notice>
              Only edited columns are changed. Existing keys, indexes,
              permissions and storage settings are preserved. Use the
              constraints controls for keys and indexes.
            </Notice>
          )}
          <h2 className="mt-2 text-sm font-semibold">
            Constraints and indexes
          </h2>
          <div className="flex flex-wrap items-end gap-3">
            <Choice
              label="Operation"
              value={constraint}
              onChange={setConstraint}
              options={["INDEX", "PRIMARY KEY", "UNIQUE", "CHECK", "DROP"]}
            />
            <Text
              label="Constraint / index name"
              value={constraintName}
              onChange={setConstraintName}
            />
            {constraint !== "CHECK" && (
              <Text
                label="Columns in key order, comma separated"
                value={constraintColumns}
                onChange={setConstraintColumns}
              />
            )}
            {constraint === "CHECK" && (
              <Text
                label="Check expression"
                value={expression}
                onChange={setExpression}
              />
            )}
            <Operation
              context={tab}
              script={constraintScript}
              label="Preview constraint"
            />
          </div>
          {tab.objectId && (
            <ReadTable
              context={tab}
              resource={{ kind: "columns", objectId: tab.objectId }}
            />
          )}
        </>
      )}
    </div>
  );
}

export function ViewDesigner({ tab }: { tab: ToolTab }) {
  const [protectedView,setProtectedView]=useState(false),[indexedView,setIndexedView]=useState(false),[settingsPrefix,setSettingsPrefix]=useState("");
  const [schema, setSchema] = useState(tab.schema ?? "dbo"),
    [name, setName] = useState(tab.name ?? ""),
    [source, setSource] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [definition, setDefinition] = useState(""),
    [sqlMode, setSqlMode] = useState(!!tab.objectId),
    [error, setError] = useState<string | null>(null);
  const [whereColumn, setWhereColumn] = useState(""),
    [operator, setOperator] = useState("="),
    [value, setValue] = useState(""),
    [group, setGroup] = useState(false),
    [joinSource, setJoinSource] = useState(""),
    [joinLeft, setJoinLeft] = useState(""),
    [joinRight, setJoinRight] = useState(""),
    [joinKind, setJoinKind] = useState("INNER");
  const objects = useRead(tab, { kind: "objects" });
  const choices = objects.data
    ? records(objects.data).filter(
        (r) => r.type_desc === "USER_TABLE" || r.type_desc === "VIEW",
      )
    : [];
  const columns = useRead(
    tab,
    source ? { kind: "columns", objectId: Number(source) } : null,
  );
  const joined = useRead(
    tab,
    joinSource ? { kind: "columns", objectId: Number(joinSource) } : null,
  );
  useEffect(() => {
    if (!tab.objectId) return;
    let disposed = false;
    void Promise.all([api.script(tab.connectionId,tab.database??"master",tab.objectId,"alter"),management.read(tab,{kind:"objectProperties",objectId:tab.objectId})])
      .then(
        ([sql,metadata]) => {
          if (!disposed) {setDefinition(sql);setSqlMode(true);const object=records(metadata)[0];setIndexedView(Number(object?.index_count??"0")>0);setProtectedView(object?.is_schema_bound==="1" || /\bWITH\b/i.test(sql));setSettingsPrefix(sql.match(/^SET ANSI_NULLS [A-Z]+;\s*GO\s*SET QUOTED_IDENTIFIER [A-Z]+;\s*GO\s*/i)?.[0]??"");}
        },
        (e) => !disposed && setError(errorMessage(e)),
      );
    return () => {
      disposed = true;
    };
  }, [tab.objectId, tab.connectionId, tab.database]);
  const table = choices.find((r) => r.object_id === source),
    other = choices.find((r) => r.object_id === joinSource);
  let script = "";
  if (sqlMode && !indexedView) script = definition;
  else if (!protectedView && !indexedView && name && table && selected.length) {
    script = `${settingsPrefix}${tab.objectId ? "ALTER" : "CREATE"} VIEW ${q(schema, name)} AS\nSELECT ${selected.map((c) => "s." + n(c)).join(", ")}\nFROM ${q(table.schema ?? "dbo", table.name ?? "")} AS s`;
    if (other && joinLeft && joinRight)
      script += `\n${joinKind} JOIN ${q(other.schema ?? "dbo", other.name ?? "")} AS j ON s.${n(joinLeft)}=j.${n(joinRight)}`;
    if (whereColumn)
      script += `\nWHERE s.${n(whereColumn)} ${operator} ${operator.includes("NULL") ? "" : l(value)}`;
    if (group)
      script += `\nGROUP BY ${selected.map((c) => "s." + n(c)).join(", ")}`;
    script += ";";
  }
  function objectOptions() {
    return choices.map((r) => (
      <option key={r.object_id} value={r.object_id ?? ""}>
        {r.schema}.{r.name}
      </option>
    ));
  }
  function columnOptions(data: typeof columns.data) {
    return data
      ? records(data).map((r) => (
          <option key={r.name} value={r.name ?? ""}>
            {r.name}
          </option>
        ))
      : null;
  }
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap gap-3">
        {tab.objectId ? <p className="text-sm">{schema}.{name}</p> : <><Text label="Schema" value={schema} onChange={setSchema} /><Text label="View name" value={name} onChange={setName} /></>}
        <Choice
          label="Editing mode"
          value={sqlMode ? "sql" : "visual"}
          onChange={(mode) => setSqlMode(mode === "sql")}
          options={protectedView || indexedView ? [["sql","SQL definition"]] : [
            ["sql", "SQL definition"],
            [
              "visual",
              tab.objectId
                ? "Graphical replacement (review before applying)"
                : "Graphical designer",
            ],
          ]}
        />
      </div>
      {error && <Notice error>{error}</Notice>}
      {indexedView && <Notice>Changing this indexed view requires an explicit migration that preserves its indexes. The designer will not apply an ALTER automatically.<Button size="sm" variant="outline" onClick={()=>void useQueries.getState().open(tab.connectionId,tab.database,{text:definition,dirty:true})}>Open definition in query</Button></Notice>}
      {protectedView && !indexedView && <Notice>The original view options are retained in SQL. Graphical replacement is unavailable for this definition.</Notice>}
      {sqlMode ? (
        <textarea
          aria-label="View SQL definition"
          className="min-h-72 rounded border bg-background p-3 font-mono text-xs"
          value={definition}
          onChange={(e) => setDefinition(e.target.value)}
        />
      ) : (
        <>
          <Field label="Source object">
            <select
              className={inputClass}
              value={source}
              onChange={(e) => {
                setSource(e.target.value);
                setSelected([]);
              }}
            >
              <option value="">Select source</option>
              {objectOptions()}
            </select>
          </Field>
          <div className="flex flex-wrap gap-3">
            {columns.data &&
              records(columns.data).map((r) => (
                <label key={r.name} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(r.name ?? "")}
                    onChange={(e) =>
                      setSelected((s) =>
                        e.target.checked
                          ? [...s, r.name ?? ""]
                          : s.filter((c) => c !== r.name),
                      )
                    }
                  />
                  {r.name}
                </label>
              ))}
          </div>
          <div className="grid grid-cols-4 gap-3">
            <Field label="Join object">
              <select
                className={inputClass}
                value={joinSource}
                onChange={(e) => setJoinSource(e.target.value)}
              >
                <option value="">No join</option>
                {objectOptions()}
              </select>
            </Field>
            <Choice
              label="Join type"
              value={joinKind}
              onChange={setJoinKind}
              options={["INNER", "LEFT", "RIGHT", "FULL"]}
            />
            <Field label="Source key">
              <select
                className={inputClass}
                value={joinLeft}
                onChange={(e) => setJoinLeft(e.target.value)}
              >
                <option value="">Select column</option>
                {columnOptions(columns.data)}
              </select>
            </Field>
            <Field label="Joined key">
              <select
                className={inputClass}
                value={joinRight}
                onChange={(e) => setJoinRight(e.target.value)}
              >
                <option value="">Select column</option>
                {columnOptions(joined.data)}
              </select>
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Field label="Filter column">
              <select
                className={inputClass}
                value={whereColumn}
                onChange={(e) => setWhereColumn(e.target.value)}
              >
                <option value="">No filter</option>
                {columnOptions(columns.data)}
              </select>
            </Field>
            <Choice
              label="Comparison"
              value={operator}
              onChange={setOperator}
              options={[
                "=",
                "<>",
                ">",
                "<",
                ">=",
                "<=",
                "LIKE",
                "IS NULL",
                "IS NOT NULL",
              ]}
            />
            <Text
              label="Filter value (literal)"
              value={value}
              onChange={setValue}
            />
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={group}
                onChange={(e) => setGroup(e.target.checked)}
              />
              Group selected columns
            </label>
          </div>
        </>
      )}
      {script && !sqlMode && (
        <pre className="max-h-60 overflow-auto rounded border p-3 text-xs select-text">
          {script}
        </pre>
      )}
      <Operation context={tab} script={script} label="Preview view changes" />
    </div>
  );
}

type Position = { x: number; y: number };
export function RelationshipDiagram({ context }: { context: Context }) {
  const objects = useRead(context, { kind: "objects" }),
    relations = useRead(context, { kind: "relations" });
  const [positions, setPositions] = useState<Record<string, Position>>(() => {
      try {
        return JSON.parse(
          localStorage.getItem(
            `quervio.diagram.${context.connectionId}.${context.database}`,
          ) ?? "{}",
        );
      } catch {
        return {};
      }
    }),
    [zoom, setZoom] = useState(1),
    [error, setError] = useState<string | null>(null);
  const drag = useRef<{ id: string; offsetX: number; offsetY: number } | null>(
    null,
  );
  const [parent, setParent] = useState(""),
    [referenced, setReferenced] = useState(""),
    [keyName, setKeyName] = useState(""),
    [left, setLeft] = useState(""),
    [right, setRight] = useState(""),
    [onDelete, setOnDelete] = useState("NO ACTION"),
    [onUpdate, setOnUpdate] = useState("NO ACTION"),
    [replace, setReplace] = useState(false);
  const tables = objects.data
    ? records(objects.data).filter((o) => o.type_desc === "USER_TABLE")
    : [];
  const links = relations.data ? records(relations.data) : [];
  function position(id: string, i: number) {
    return (
      positions[id] ?? {
        x: (i % 4) * 250 + 20,
        y: Math.floor(i / 4) * 120 + 20,
      }
    );
  }
  useEffect(() => {
    localStorage.setItem(
      `quervio.diagram.${context.connectionId}.${context.database}`,
      JSON.stringify(positions),
    );
  }, [positions, context.connectionId, context.database]);
  const p = tables.find((t) => t.object_id === parent),
    r = tables.find((t) => t.object_id === referenced);
  let script = "",
    validation = "";
  try {
    if (p && r && keyName && left && right)
      script = foreignKeyScript({
        schema: p.schema ?? "dbo",
        table: p.name ?? "",
        name: keyName,
        columns: left.split(",").map((s) => s.trim()),
        referencedSchema: r.schema ?? "dbo",
        referencedTable: r.name ?? "",
        referencedColumns: right.split(",").map((s) => s.trim()),
        onDelete,
        onUpdate,
        replace,
      });
  } catch (e) {
    validation = errorMessage(e);
  }
  function selectRelation(row: Record<string, string | null>) {
    setParent(
      tables.find(
        (t) => t.schema === row.parent_schema && t.name === row.parent_table,
      )?.object_id ?? "",
    );
    setReferenced(
      tables.find(
        (t) =>
          t.schema === row.referenced_schema && t.name === row.referenced_table,
      )?.object_id ?? "",
    );
    setKeyName(row.name ?? "");
    const group = links.filter(
      (l) =>
        l.name === row.name &&
        l.parent_schema === row.parent_schema &&
        l.parent_table === row.parent_table,
    );
    setLeft(group.map((l) => l.parent_column).join(","));
    setRight(group.map((l) => l.referenced_column).join(","));
    setOnDelete(
      (row.delete_referential_action_desc ?? "NO_ACTION").replace(/_/g, " "),
    );
    setOnUpdate(
      (row.update_referential_action_desc ?? "NO_ACTION").replace(/_/g, " "),
    );
    setReplace(true);
  }
  async function file(importing: boolean) {
    try {
      if (importing) {
        const path = await open({
          multiple: false,
          filters: [{ name: "Diagram layout", extensions: ["json"] }],
        });
        if (path) {
          const value = JSON.parse(await api.fileRead(path));
          if (
            typeof value !== "object" ||
            Object.values(value).some(
              (v) =>
                typeof v !== "object" ||
                v === null ||
                !Number.isFinite((v as Position).x) ||
                !Number.isFinite((v as Position).y),
            )
          )
            throw new Error("Invalid diagram positions.");
          setPositions(value);
        }
      } else {
        const path = await save({ defaultPath: "relationships.json" });
        if (path) await api.fileWrite(path, JSON.stringify(positions, null, 2));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div className="flex items-center gap-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            objects.refresh();
            relations.refresh();
          }}
        >
          Refresh
        </Button>
        <Button size="sm" variant="outline" onClick={() => void file(false)}>
          Export layout
        </Button>
        <Button size="sm" variant="outline" onClick={() => void file(true)}>
          Import layout
        </Button>
        <label className="ml-auto text-xs">
          Zoom{" "}
          <input
            aria-label="Diagram zoom"
            type="range"
            min="0.4"
            max="1.5"
            step="0.1"
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
          />
        </label>
      </div>
      {(objects.error || relations.error || error) && (
        <Notice error>{objects.error ?? relations.error ?? error}</Notice>
      )}
      <div className="h-96 shrink-0 overflow-auto rounded border">
        <svg
          width={
            Math.max(
              1050,
              ...tables.map((t, i) => position(t.object_id!, i).x + 240),
            ) * zoom
          }
          height={
            Math.max(
              370,
              ...tables.map((t, i) => position(t.object_id!, i).y + 100),
            ) * zoom
          }
          style={{ touchAction: "none" }}
          onPointerMove={(e) => {
            const current = drag.current;
            if (!current) return;
            const rect = e.currentTarget.getBoundingClientRect();
            setPositions((s) => ({
              ...s,
              [current.id]: {
                x: Math.max(
                  0,
                  (e.clientX - rect.left) / zoom - current.offsetX,
                ),
                y: Math.max(0, (e.clientY - rect.top) / zoom - current.offsetY),
              },
            }));
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
        >
          <g transform={`scale(${zoom})`}>
            {links
              .filter(
                (link, i) =>
                  links.findIndex(
                    (l) =>
                      l.name === link.name &&
                      l.parent_table === link.parent_table &&
                      l.parent_schema === link.parent_schema,
                  ) === i,
              )
              .map((link, i) => {
                const a = tables.findIndex(
                    (t) =>
                      t.schema === link.parent_schema &&
                      t.name === link.parent_table,
                  ),
                  b = tables.findIndex(
                    (t) =>
                      t.schema === link.referenced_schema &&
                      t.name === link.referenced_table,
                  );
                if (a < 0 || b < 0) return null;
                const from = position(tables[a].object_id!, a),
                  to = position(tables[b].object_id!, b);
                return (
                  <g
                    key={i}
                    onClick={() => selectRelation(link)}
                    className="cursor-pointer"
                  >
                    <path
                      d={`M${from.x + 210},${from.y + 35} L${to.x},${to.y + 35}`}
                      stroke="var(--primary)"
                      strokeWidth="2"
                      fill="none"
                    />
                    <text
                      x={(from.x + to.x) / 2 + 90}
                      y={(from.y + to.y) / 2 + 25}
                      fill="var(--muted-foreground)"
                      fontSize="10"
                    >
                      {link.name}
                    </text>
                  </g>
                );
              })}
            {tables.map((t, i) => {
              const pos = position(t.object_id!, i);
              return (
                <g
                  key={t.object_id}
                  transform={`translate(${pos.x},${pos.y})`}
                  role="button"
                  tabIndex={0}
                  aria-label={`${t.schema}.${t.name}, drag to move`}
                  onPointerDown={(e) => {
                    e.currentTarget.setPointerCapture(e.pointerId);
                    const rect =
                      e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                    drag.current = {
                      id: t.object_id!,
                      offsetX: (e.clientX - rect.left) / zoom - pos.x,
                      offsetY: (e.clientY - rect.top) / zoom - pos.y,
                    };
                  }}
                  onDoubleClick={() => setParent(t.object_id ?? "")}
                  onKeyDown={(e) => {
                    const move = {
                      ArrowLeft: [-10, 0],
                      ArrowRight: [10, 0],
                      ArrowUp: [0, -10],
                      ArrowDown: [0, 10],
                    }[e.key];
                    if (move) {
                      e.preventDefault();
                      setPositions((s) => ({
                        ...s,
                        [t.object_id!]: {
                          x: Math.max(0, pos.x + move[0]),
                          y: Math.max(0, pos.y + move[1]),
                        },
                      }));
                    }
                  }}
                  className="cursor-move"
                >
                  <rect
                    width="210"
                    height="70"
                    rx="5"
                    fill="var(--panel)"
                    stroke="var(--border)"
                  />
                  <text x="12" y="25" fontSize="12" fill="var(--foreground)">
                    {`${t.schema}.${t.name}`.slice(0, 28)}
                  </text>
                  <text
                    x="12"
                    y="47"
                    fontSize="11"
                    fill="var(--muted-foreground)"
                  >
                    {
                      links.filter(
                        (l) =>
                          l.parent_table === t.name &&
                          l.parent_schema === t.schema,
                      ).length
                    }{" "}
                    FK column mappings
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      <h2 className="text-sm font-semibold">Foreign key</h2>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Parent table">
          <select
            className={inputClass}
            value={parent}
            onChange={(e) => setParent(e.target.value)}
          >
            <option value="">Select table</option>
            {tables.map((t) => (
              <option key={t.object_id} value={t.object_id ?? ""}>
                {t.schema}.{t.name}
              </option>
            ))}
          </select>
        </Field>
        <Text
          label="Parent columns, in order"
          value={left}
          onChange={setLeft}
        />
        <Text label="Constraint name" value={keyName} onChange={setKeyName} />
        <Field label="Referenced table">
          <select
            className={inputClass}
            value={referenced}
            onChange={(e) => setReferenced(e.target.value)}
          >
            <option value="">Select table</option>
            {tables.map((t) => (
              <option key={t.object_id} value={t.object_id ?? ""}>
                {t.schema}.{t.name}
              </option>
            ))}
          </select>
        </Field>
        <Text
          label="Referenced columns, in order"
          value={right}
          onChange={setRight}
        />
        <Choice
          label="On delete"
          value={onDelete}
          onChange={setOnDelete}
          options={["NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT"]}
        />
        <Choice
          label="On update"
          value={onUpdate}
          onChange={setOnUpdate}
          options={["NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT"]}
        />
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={replace}
            onChange={(e) => setReplace(e.target.checked)}
          />
          Replace existing constraint with this name
        </label>
      </div>
      {validation && <Notice error>{validation}</Notice>}
      <Operation
        context={context}
        script={script}
        label="Preview foreign key"
        onApplied={relations.refresh}
      />
      {relations.data && (
        <DataGrid data={relations.data} onRow={selectRelation} />
      )}
    </div>
  );
}

export function ObjectProperties({ tab }: { tab: ToolTab }) {
  const [databaseAction,setDatabaseAction]=useState("inspect"),[newDatabase,setNewDatabase]=useState(""),[recovery,setRecovery]=useState("FULL"),[readOnly,setReadOnly]=useState("READ_ONLY"),[force,setForce]=useState(false);
  const databaseScript=databaseAction==="create" && newDatabase ? `CREATE DATABASE ${n(newDatabase)};` : databaseAction==="drop" && tab.database ? `DROP DATABASE ${n(tab.database)};` : databaseAction==="recovery" && tab.database ? `ALTER DATABASE ${n(tab.database)} SET RECOVERY ${recovery};` : databaseAction==="access" && tab.database ? `ALTER DATABASE ${n(tab.database)} SET ${readOnly}${force?" WITH ROLLBACK IMMEDIATE":""};` : "";
  const [definition, setDefinition] = useState(""),
    [error, setError] = useState<string | null>(null),
    [kind, setKind] = useState("TABLE");
  useEffect(() => {
    if (!tab.objectId) return;
    let disposed = false;
    void (async () => {
      const result = await management.read(tab, {
        kind: "objectProperties",
        objectId: tab.objectId!,
      });
      const object = records(result)[0];
      if (!object)
        throw new Error("Object not found or its metadata is not visible.");
      const type = object.type_desc ?? "";
      if (!disposed)
        setKind(
          type.includes("TABLE")
            ? "TABLE"
            : type.includes("VIEW")
              ? "VIEW"
              : type.includes("PROCEDURE")
                ? "PROCEDURE"
                : type.includes("TRIGGER")
                  ? "TRIGGER"
                  : "FUNCTION",
        );
      if (type === "USER_TABLE") {
        const sql = await api.script(
          tab.connectionId,
          tab.database ?? "master",
          tab.objectId!,
          "createTable",
        );
        if (!disposed) setDefinition(sql);
      } else if (object.definition) {
        const sql = await api.script(
          tab.connectionId,
          tab.database ?? "master",
          tab.objectId!,
          "alter",
        );
        if (!disposed) setDefinition(sql);
      } else
        throw new Error(
          "The module definition is encrypted or VIEW DEFINITION permission is missing.",
        );
    })().catch((error) => !disposed && setError(errorMessage(error)));
    return () => {
      disposed = true;
    };
  }, [tab.objectId, tab.connectionId, tab.database, tab.schema, tab.name]);
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      {error && <Notice error>{error}</Notice>}
      <ReadTable
        context={tab}
        resource={
          tab.objectId
            ? { kind: "columns", objectId: tab.objectId }
            : { kind: "properties" }
        }
      />
      {!tab.objectId && <><Choice label="Database operation" value={databaseAction} onChange={setDatabaseAction} options={[["inspect","Inspect properties"],["create","Create database"],["recovery","Change recovery model"],["access","Change read-only state"],["drop","Drop selected database"]]}/>{databaseAction==="create" && <Text label="New database name" value={newDatabase} onChange={setNewDatabase}/>} {databaseAction==="recovery" && <Choice label="Recovery model" value={recovery} onChange={setRecovery} options={["FULL","SIMPLE","BULK_LOGGED"]}/>} {databaseAction==="access" && <><Choice label="Access mode" value={readOnly} onChange={setReadOnly} options={["READ_ONLY","READ_WRITE"]}/><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={force} onChange={e=>setForce(e.target.checked)}/>Disconnect existing sessions and roll back their open transactions</label></>} {databaseScript && <Operation context={{...tab,database:"master"}} script={databaseScript} label="Preview database operation"/>}</>}
      {tab.objectId && <>
      <textarea
        aria-label="Object SQL definition"
        value={definition}
        onChange={(e) => setDefinition(e.target.value)}
        className="min-h-72 rounded border bg-background p-3 font-mono text-xs"
      />
      <Operation
        context={tab}
        script={definition}
        label="Preview SQL definition"
      />
      {tab.name && (
        <div className="flex items-end gap-3">
          <Choice
            label="Object type for DROP"
            value={kind}
            onChange={setKind}
            options={["TABLE", "VIEW", "PROCEDURE", "FUNCTION", "TRIGGER"]}
          />
          <Operation
            context={tab}
            script={`DROP ${kind} ${q(tab.schema ?? "dbo", tab.name)};`}
            label="Preview DROP"
          />
        </div>
      )}
      </>}
    </div>
  );
}
