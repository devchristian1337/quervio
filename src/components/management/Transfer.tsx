import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { type Context, type DataTable } from "@/lib/management-api";
import { cn } from "@/lib/utils";
import {
  BridgeOperation,
  Check,
  Choice,
  codeClass,
  DataGrid,
  Field,
  inputClass,
  Notice,
  Text,
  textareaClass,
  ViewTabs,
} from "./shared";
import { Button } from "@/components/ui/button";

export function Transfer({ context }: { context: Context }) {
  const [mode, setMode] = useState("import"),
    [source, setSource] = useState("file"),
    [path, setPath] = useState(""),
    [schema, setSchema] = useState("dbo"),
    [table, setTable] = useState(""),
    [delimiter, setDelimiter] = useState(","),
    [nullToken, setNullToken] = useState("\\N"),
    [sheet, setSheet] = useState("0"),
    [sourceConnection, setSourceConnection] = useState(""),
    [sourceQuery, setSourceQuery] = useState(""),
    [mapping, setMapping] = useState("{}"),
    [preview, setPreview] = useState<DataTable | null>(null),
    [scriptMode, setScriptMode] = useState("schema"),
    [objects, setObjects] = useState(""),
    [targetVersion, setTargetVersion] = useState("16"),
    [dropMissing, setDropMissing] = useState(false),
    [packageHash, setPackageHash] = useState(""),
    [report, setReport] = useState(""),
    [targetDatabase, setTargetDatabase] = useState(context.database ?? ""),
    [keepIdentity, setKeepIdentity] = useState(false);
  const [backslashEscaping, setBackslashEscaping] = useState(false);
  let parsed: unknown = {},
    validation = "";
  try {
    parsed = JSON.parse(mapping);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Column mapping must be a JSON object.");
    if (Object.values(parsed).some((value) => typeof value !== "string"))
      throw new Error("Every destination column name must be a string.");
  } catch (e) {
    validation = e instanceof Error ? e.message : String(e);
  }
  async function choose(saving: boolean) {
    const value = saving
      ? await save({
          defaultPath:
            mode === "script"
              ? "database.sql"
              : mode === "extract" || mode === "publish"
                ? "database.dacpac"
                : mode.includes("Bacpac")
                  ? "database.bacpac"
                  : "data.csv",
        })
      : await open({ multiple: false });
    if (value) {
      setPath(value);
      setPackageHash("");
      setReport("");
      setPreview(null);
    }
  }
  const args = {
    path,
    source,
    schema,
    table,
    delimiter,
    nullToken,
    sheet: Number(sheet),
    sourceConnection,
    sourceQuery,
    mapping: parsed,
    keepIdentity,
    backslashEscaping,
  };
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <ViewTabs
        label="Transfer operation"
        value={mode}
        onChange={(v) => {
          setMode(v);
          setPath("");
          setPackageHash("");
          setReport("");
          setPreview(null);
        }}
        options={[
          ["import", "Import CSV / Excel / ODBC"],
          ["export", "Export table to CSV / Excel"],
          ["script", "Generate .sql script"],
          ["extract", "Extract .dacpac"],
          ["publish", "Publish .dacpac"],
          ["exportBacpac", "Export .bacpac"],
          ["importBacpac", "Import .bacpac"],
        ]}
      />
      <div className="flex items-end gap-3">
        <div className="flex-1">
          <Text
            label="Local file path"
            value={path}
            onChange={(v) => {
              setPath(v);
              setPackageHash("");
            }}
          />
        </div>
        <Button
          variant="outline"
          onClick={() =>
            void choose(
              ["export", "script", "extract", "exportBacpac"].includes(mode),
            )
          }
        >
          Browse
        </Button>
      </div>
      {["import", "export"].includes(mode) && (
        <div className="grid grid-cols-2 gap-3">
          <Text label="SQL Server schema" value={schema} onChange={setSchema} />
          <Text label="SQL Server table" value={table} onChange={setTable} />
        </div>
      )}
      {mode === "import" && (
        <>
          <Choice
            label="Source"
            value={source}
            onChange={setSource}
            options={[
              ["file", "CSV / Excel file"],
              ["odbc", "Database through installed 64-bit ODBC driver"],
            ]}
          />
          {source === "file" ? (
            <div className="grid grid-cols-3 gap-3">
              <Text
                label="CSV delimiter"
                value={delimiter}
                onChange={setDelimiter}
              />
              <Text
                label="CSV NULL token"
                value={nullToken}
                onChange={setNullToken}
              />
              <Text
                label="Excel worksheet index (zero based)"
                value={sheet}
                onChange={setSheet}
                type="number"
              />
            </div>
          ) : (
            <>
              <Text
                label="ODBC source connection string (not saved)"
                value={sourceConnection}
                onChange={setSourceConnection}
                type="password"
              />
              <Text
                label="Source SELECT query"
                value={sourceQuery}
                onChange={setSourceQuery}
              />
            </>
          )}
          <BridgeOperation
            context={context}
            action="importPreview"
            args={args}
            label="Preview source rows"
            onResult={(value) =>
              setPreview({ ...(value as DataTable), truncated: false })
            }
          />
          {preview && (
            <>
              <DataGrid data={preview} />
              <h2 className="border-b pb-2 text-sm font-medium">Column mapping</h2>
              <div className="max-h-72 shrink-0 overflow-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-panel">
                    <tr className="text-xs text-muted-foreground">
                      <th className="h-8 px-3 text-left font-medium">Source column</th>
                      <th className="h-8 px-3 text-left font-medium">Destination column</th>
                      <th className="h-8 px-3 text-center font-medium">Ignore</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.columns.map((column, index) => {
                      const values = validation
                        ? {}
                        : (parsed as Record<string, string>);
                      return (
                        <tr key={index} className="border-t">
                          <td className="px-3 py-1">{column}</td>
                          <td className="px-3 py-1">
                            <input
                              className={inputClass}
                              aria-label={`Destination column for ${column}`}
                              disabled={values[column] === ""}
                              value={values[column] ?? column}
                              onChange={(e) =>
                                setMapping(
                                  JSON.stringify(
                                    { ...values, [column]: e.target.value },
                                    null,
                                    2,
                                  ),
                                )
                              }
                            />
                          </td>
                          <td className="px-3 py-1 text-center">
                            <Check
                              aria-label={`Ignore source column ${column}`}
                              checked={values[column] === ""}
                              onChange={(checked) =>
                              setMapping(
                              JSON.stringify(
                              {
                              ...values,
                              [column]: checked ? "" : column,
                              },
                              null,
                              2,
                              ),
                              )
                              }
                              />
                              </td>
                              </tr>
                              );
                              })}
                              </tbody>
                              </table>
                              </div>
                              </>
                              )}
                              {source === "file" && (
                              <Check
                              label="Decode Quervio CSV backslash escaping (enable for files exported by Quervio)"
                              checked={backslashEscaping}
                              onChange={setBackslashEscaping}
                            />
          )}
          <Field label="Column mapping JSON" htmlFor="column-mapping">
            <textarea
              id="column-mapping"
              className={cn(textareaClass, "min-h-24")}
              value={mapping}
              onChange={(e) => setMapping(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Source names to destination names. Omitted names map identically.
            </p>
          </Field>
          <Check
            label="Keep source identity values"
            checked={keepIdentity}
            onChange={setKeepIdentity}
          />
          <Notice>
            Import uses one destination transaction, validates constraints and
            rolls back on conversion or transfer errors. CSV uses \N for NULL; a
            leading backslash in a non-NULL value is escaped with another
            backslash.
          </Notice>
          {validation ? (
            <Notice error>{validation}</Notice>
          ) : (
            <BridgeOperation
              context={context}
              action="import"
              args={args}
              label="Import data"
              write
            />
          )}
        </>
      )}
      {mode === "export" && (
        <>
          <Notice>
            Choose .csv or .xlsx. Decimal, date and binary values are exported
            exactly as text; Excel does not round large numeric values.
            CSV rejects formula-like text in values or column names; use .xlsx
            to preserve these values safely as text.
          </Notice>
          <BridgeOperation
            context={context}
            action="export"
            args={{ path, schema, table }}
            label="Export table"
          />
        </>
      )}
      {mode === "script" && (
        <>
          <Choice
            label="Script contents"
            value={scriptMode}
            onChange={setScriptMode}
            options={[
              ["schema", "Structure"],
              ["data", "Data"],
              ["both", "Structure and data"],
            ]}
          />
          <Text
            label="Objects (schema.name, comma separated; empty = all user objects)"
            value={objects}
            onChange={setObjects}
          />
          <Choice
            label="Target SQL Server"
            value={targetVersion}
            onChange={setTargetVersion}
            options={[
              ["11", "2012"],
              ["12", "2014"],
              ["13", "2016"],
              ["14", "2017"],
              ["15", "2019"],
              ["16", "2022"],
              ["17", "2025"],
            ]}
          />
          <BridgeOperation
            context={context}
            action="script"
            args={{
              path,
              mode: scriptMode,
              objects: objects
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
              targetVersion: Number(targetVersion),
              dependencies: true,
            }}
            label="Generate SQL file"
          />
        </>
      )}
      {mode === "extract" && (
        <BridgeOperation
          context={context}
          action="extract"
          args={{ path }}
          label="Extract schema package"
        />
      )}
      {mode === "publish" && (
        <>
          <Check
            label="Drop destination objects absent from the package"
            checked={dropMissing}
            onChange={(checked) => {
              setDropMissing(checked);
              setPackageHash("");
            }}
          />
          <BridgeOperation
            context={context}
            action="dacPreview"
            args={{ path, dropMissing }}
            label="Generate deployment preview"
            onResult={(value) => {
              const result = value as {
                packageHash: string;
                script: string;
                report: string;
              };
              setPackageHash(result.packageHash);
              setReport(result.script + "\n\n" + result.report);
            }}
          />
          {report && (
            <pre className={cn(codeClass, "max-h-96")}>
              {report}
            </pre>
          )}
          {packageHash && (
            <BridgeOperation
              context={context}
              action="dacPublish"
              args={{ path, dropMissing, packageHash }}
              label="Publish reviewed package"
              write
            />
          )}
        </>
      )}
      {mode === "exportBacpac" && (
        <BridgeOperation
          context={context}
          action="bacpacExport"
          args={{ path }}
          label="Export schema and data package"
        />
      )}
      {mode === "importBacpac" && (
        <>
          <Text
            label="Destination database"
            value={targetDatabase}
            onChange={setTargetDatabase}
          />
          <BridgeOperation
            context={context}
            action="bacpacImport"
            args={{ path, targetDatabase }}
            label="Import schema and data package"
            write
          />
        </>
      )}
    </div>
  );
}
