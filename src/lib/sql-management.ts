import {
  qualifiedName as q,
  quoteName as n,
  sqlLiteral as l,
} from "@/lib/management-api";

export function identifier(value: string) {
  if (!value.trim() || value.length > 128 || value.includes("\0"))
    throw new Error("Identifiers must contain 1–128 characters.");
  return n(value);
}
export interface ColumnDefinition {
  originalName?: string;
  name: string;
  type: string;
  nullable: boolean;
  identity: boolean;
  seed: string;
  increment: string;
  computed: string;
  defaultValue: string;
  defaultName?: string;
  /** The column's collation, kept when ALTER COLUMN restates its type. */
  collation?: string;
}
export interface TableDefinition {
  schema: string;
  name: string;
  columns: ColumnDefinition[];
  primaryKey: string[];
}
export function columnType(value: string) {
  if (
    !/^(?:bigint|int|smallint|tinyint|bit|money|smallmoney|real|float(?:\(\d{1,2}\))?|date|datetime|smalldatetime|datetime2(?:\([0-7]\))?|datetimeoffset(?:\([0-7]\))?|time(?:\([0-7]\))?|uniqueidentifier|xml|(?:n?varchar|varbinary)\((?:max|[1-9]\d*)\)|(?:n?char|binary)\([1-9]\d*\)|(?:decimal|numeric)\((?:[1-9]|[12]\d|3[0-8]),\s*(?:\d|[12]\d|3[0-8])\))$/i.test(
      value.trim(),
    )
  )
    throw new Error(
      `Unsupported editable SQL type: ${value}. Use the SQL editor for user-defined types.`,
    );
  return value.trim();
}
function column(c: ColumnDefinition) {
  identifier(c.name);
  if (c.computed.trim()) return `${n(c.name)} AS ${c.computed}`;
  if (
    c.identity &&
    (!/^-?\d+$/.test(c.seed) ||
      !/^-?\d+$/.test(c.increment) ||
      Number(c.increment) === 0)
  )
    throw new Error("Identity seed and nonzero increment must be integers.");
  return `${n(c.name)} ${columnType(c.type)}${c.identity ? ` IDENTITY(${c.seed},${c.increment})` : ""} ${c.nullable ? "NULL" : "NOT NULL"}${c.defaultValue.trim() ? ` DEFAULT ${c.defaultValue}` : ""}`;
}
export function tableScript(
  table: TableDefinition,
  original?: TableDefinition,
) {
  identifier(table.schema);
  identifier(table.name);
  if (!table.columns.length)
    throw new Error("A table needs at least one column.");
  if (
    new Set(table.columns.map((c) => c.name.toLowerCase())).size !==
    table.columns.length
  )
    throw new Error("Column names must be unique.");
  const target = q(table.schema, table.name);
  if (
    table.primaryKey.some((name) => !table.columns.some((c) => c.name === name))
  )
    throw new Error("Primary key columns must exist in the table.");
  if (!original)
    return `CREATE TABLE ${target} (\n  ${[...table.columns.map(column), ...(table.primaryKey.length ? [`PRIMARY KEY (${table.primaryKey.map(n).join(", ")})`] : [])].join(",\n  ")}\n);`;
  if (table.schema !== original.schema || table.name !== original.name)
    throw new Error("Change schema and object names in the SQL editor.");
  // An existing column is the one that carries its original name; a column
  // without one matches by name only when no renamed column claims it, so a
  // new column may reuse a name another column was renamed from.
  const matched = new Map<ColumnDefinition, ColumnDefinition>();
  for (const old of original.columns) {
    const next =
      table.columns.find((c) => c.originalName === old.name) ??
      table.columns.find(
        (c) =>
          c.originalName === undefined && c.name === old.name && !matched.has(c),
      );
    if (next) matched.set(next, old);
  }
  const drops: string[] = [],
    renames: { from: string; to: string }[] = [],
    changes: string[] = [];
  for (const old of original.columns) {
    const next = [...matched].find(([, o]) => o === old)?.[0];
    if (!next) {
      if (old.defaultName)
        drops.push(`ALTER TABLE ${target} DROP CONSTRAINT ${n(old.defaultName)};`);
      drops.push(`ALTER TABLE ${target} DROP COLUMN ${n(old.name)};`);
      continue;
    }
    if (next.name !== old.name) renames.push({ from: old.name, to: next.name });
    if (
      next.identity !== old.identity ||
      next.seed !== old.seed ||
      next.increment !== old.increment ||
      next.computed !== old.computed
    )
      throw new Error(
        "Identity/computed changes require a reviewed SQL migration; this designer never recreates the table.",
      );
    const retyped = next.type !== old.type;
    const defaultChanged = next.defaultValue !== old.defaultValue;
    // SQL Server will not change the type of a column a default depends on.
    const dropDefault = !!old.defaultName && (defaultChanged || retyped);
    if (dropDefault)
      changes.push(`ALTER TABLE ${target} DROP CONSTRAINT ${n(old.defaultName!)};`);
    if (retyped || next.nullable !== old.nullable) {
      const collation =
        old.collation && /char|text/i.test(next.type)
          ? ` COLLATE ${collationName(old.collation)}`
          : "";
      changes.push(
        `ALTER TABLE ${target} ALTER COLUMN ${n(next.name)} ${columnType(next.type)}${collation} ${next.nullable ? "NULL" : "NOT NULL"};`,
      );
    }
    if ((dropDefault || (defaultChanged && !old.defaultName)) && next.defaultValue.trim())
      changes.push(
        `ALTER TABLE ${target} ADD ${old.defaultName && !defaultChanged ? `CONSTRAINT ${n(old.defaultName)} ` : ""}DEFAULT ${next.defaultValue} FOR ${n(next.name)};`,
      );
  }
  const statements = [...drops];
  // Renames that reuse a name still in use (a swap) go through temporary names.
  const taken = new Set(original.columns.map((c) => c.name.toLowerCase()));
  const viaTemporary = renames.some((r) => taken.has(r.to.toLowerCase()));
  const rename = (from: string, to: string) =>
    `EXEC sys.sp_rename @objname=${l(`${target}.${n(from)}`)}, @newname=${l(to)}, @objtype=N'COLUMN';`;
  if (viaTemporary) {
    renames.forEach((r, i) => statements.push(rename(r.from, `__quervio_rename_${i}`)));
    renames.forEach((r, i) => statements.push(rename(`__quervio_rename_${i}`, r.to)));
  } else renames.forEach((r) => statements.push(rename(r.from, r.to)));
  statements.push(...changes);
  for (const added of table.columns.filter((c) => !matched.has(c)))
    statements.push(`ALTER TABLE ${target} ADD ${column(added)};`);
  if (JSON.stringify(table.primaryKey) !== JSON.stringify(original.primaryKey))
    throw new Error(
      "Edit an existing primary key through the constraints script to preserve its name and storage options.",
    );
  return statements.length ? transactional(statements.join("\n")) : "";
}

function collationName(value: string) {
  if (!/^[A-Za-z0-9_]{1,128}$/.test(value)) throw new Error(`Invalid collation: ${value}`);
  return value;
}

export function transactional(sql: string) {
  return `SET XACT_ABORT ON;\nBEGIN TRY\nBEGIN TRANSACTION;\n${sql}\nCOMMIT TRANSACTION;\nEND TRY\nBEGIN CATCH\nIF @@TRANCOUNT>0 ROLLBACK TRANSACTION;\nTHROW;\nEND CATCH;`;
}

export interface ForeignKey {
  schema: string;
  table: string;
  name: string;
  columns: string[];
  referencedSchema: string;
  referencedTable: string;
  referencedColumns: string[];
  onDelete: string;
  onUpdate: string;
  replace?: boolean;
}
export function foreignKeyScript(fk: ForeignKey) {
  [
    fk.schema,
    fk.table,
    fk.name,
    fk.referencedSchema,
    fk.referencedTable,
    ...fk.columns,
    ...fk.referencedColumns,
  ].forEach(identifier);
  if (!fk.columns.length || fk.columns.length !== fk.referencedColumns.length)
    throw new Error(
      "Map the same nonzero number of parent and referenced columns, in key order.",
    );
  const actions = new Set(["NO ACTION", "CASCADE", "SET NULL", "SET DEFAULT"]);
  if (!actions.has(fk.onDelete) || !actions.has(fk.onUpdate))
    throw new Error("Invalid referential action.");
  const sql = `${fk.replace ? `ALTER TABLE ${q(fk.schema, fk.table)} DROP CONSTRAINT ${n(fk.name)};\n` : ""}ALTER TABLE ${q(fk.schema, fk.table)} WITH CHECK ADD CONSTRAINT ${n(fk.name)} FOREIGN KEY (${fk.columns.map(n).join(", ")}) REFERENCES ${q(fk.referencedSchema, fk.referencedTable)} (${fk.referencedColumns.map(n).join(", ")}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate};`;
  return fk.replace ? transactional(sql) : sql;
}

export interface BackupOptions {
  database: string;
  path: string;
  kind: "full" | "differential" | "log";
  copyOnly: boolean;
  compression: boolean;
  checksum: boolean;
}
export function backupScript(o: BackupOptions) {
  identifier(o.database);
  if (!o.path) throw new Error("Choose a server-side backup destination.");
  if (o.kind === "differential" && o.copyOnly)
    throw new Error("COPY_ONLY is not valid for a differential backup.");
  const options = [
    o.kind === "differential" ? "DIFFERENTIAL" : "",
    o.copyOnly ? "COPY_ONLY" : "",
    o.compression ? "COMPRESSION" : "",
    o.checksum ? "CHECKSUM" : "",
    "STATS=5",
  ].filter(Boolean);
  return `BACKUP ${o.kind === "log" ? "LOG" : "DATABASE"} ${n(o.database)} TO ${o.path.startsWith("https://") ? "URL" : "DISK"}=${l(o.path)} WITH ${options.join(", ")};`;
}
export interface RestoreSource {
  path: string;
  position: number;
  kind: "database" | "log";
  firstLsn?: string;
  lastLsn?: string;
  checkpointLsn?: string;
  databaseBackupLsn?: string;
  backupType?: number;
  databaseName?: string;
  recoveryFork?: string;
}
export function validateRestoreChain(sources: RestoreSource[]) {
  if (!sources.length || sources[0].backupType !== 1)
    throw new Error(
      "Select a full database backup as the first restore source.",
    );
  const lsn = (value: string | undefined) => {
    if (!value || !/^\d+(?:\.0+)?$/.test(value))
      throw new Error(
        "Backup LSN metadata is missing. Inspect every backup before restoring.",
      );
    return BigInt(value.split(".")[0]);
  };
  const base = lsn(sources[0].checkpointLsn);
  let current = lsn(sources[0].lastLsn),
    hasLog = false;
  for (const source of sources.slice(1)) {
    if (source.databaseName !== sources[0].databaseName)
      throw new Error("Restore sources belong to different databases.");
    if (
      source.recoveryFork &&
      sources[0].recoveryFork &&
      source.recoveryFork !== sources[0].recoveryFork
    )
      throw new Error("Restore sources have different recovery forks.");
    if (source.backupType === 5) {
      if (hasLog)
        throw new Error("A differential backup must precede transaction logs.");
      if (lsn(source.databaseBackupLsn) !== base)
        throw new Error(
          "The differential backup does not reference the selected full backup.",
        );
      current = lsn(source.lastLsn);
    } else if (source.backupType === 2) {
      hasLog = true;
      if (lsn(source.firstLsn) > current || lsn(source.lastLsn) <= current)
        throw new Error("The log chain has a gap or is out of order.");
      current = lsn(source.lastLsn);
    } else
      throw new Error(
        "Only full, differential and transaction-log backups are supported in this restore chain.",
      );
  }
}
export function restoreScript(
  database: string,
  sources: RestoreSource[],
  stopAt: string,
  moves: { logical: string; physical: string }[],
  recover: boolean,
  replace: boolean,
) {
  identifier(database);
  if (!sources.length || sources[0].kind !== "database")
    throw new Error(
      "The restore chain must begin with a full database backup.",
    );
  const point = stopAt ? new Date(stopAt) : null;
  if (point && Number.isNaN(point.getTime()))
    throw new Error("Invalid point-in-time timestamp.");
  return sources
    .map((source, i) => {
      if (
        !source.path ||
        !Number.isInteger(source.position) ||
        source.position < 1
      )
        throw new Error(
          "Each backup needs a path and positive media position.",
        );
      const options = [
        `FILE=${source.position}`,
        i === sources.length - 1 && recover ? "RECOVERY" : "NORECOVERY",
        "STATS=5",
      ];
      if (i === 0) {
        if (replace) options.push("REPLACE");
        for (const move of moves)
          options.push(`MOVE ${l(move.logical)} TO ${l(move.physical)}`);
      }
      if (point && source.kind === "log")
        options.push(`STOPAT=${l(stopAt.replace("T", " "))}`);
      return `RESTORE ${source.kind === "log" ? "LOG" : "DATABASE"} ${n(database)} FROM ${source.path.startsWith("https://") ? "URL" : "DISK"}=${l(source.path)} WITH ${options.join(", ")};`;
    })
    .join("\n");
}

export type MaintenanceTask = {
  id: string;
  kind: "reorganize" | "rebuild" | "statistics" | "backup" | "history" | "sql";
  schema: string;
  table: string;
  path: string;
  sql: string;
  days: number;
  nextSuccess?: string;
  nextFailure?: string;
};
export function maintenanceScript(
  name: string,
  database: string,
  tasks: MaintenanceTask[],
  hour: number,
  minute: number,
) {
  identifier(name);
  identifier(database);
  if (!tasks.length) throw new Error("Add at least one maintenance task.");
  if (
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  )
    throw new Error("Invalid schedule time.");
  const ids = new Map(tasks.map((task, index) => [task.id, index + 1]));
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id))
      throw new Error("Maintenance flows cannot contain cycles.");
    if (visited.has(id)) return;
    active.add(id);
    const t = tasks.find((t) => t.id === id);
    if (!t) throw new Error("A flow target does not exist.");
    const defaultNext = tasks[tasks.indexOf(t) + 1]?.id;
    for (const edge of [t.nextSuccess ?? defaultNext, t.nextFailure])
      if (edge) visit(edge);
    active.delete(id);
    visited.add(id);
  }
  tasks.forEach((t) => visit(t.id));
  function taskSql(t: MaintenanceTask) {
    if (["reorganize", "rebuild", "statistics"].includes(t.kind)) {
      identifier(t.schema);
      identifier(t.table);
    }
    switch (t.kind) {
      case "reorganize":
      case "rebuild":
        return `ALTER INDEX ALL ON ${q(t.schema, t.table)} ${t.kind === "rebuild" ? "REBUILD" : "REORGANIZE"};`;
      case "statistics":
        return `UPDATE STATISTICS ${q(t.schema, t.table)};`;
      case "backup":
        return backupScript({
          database,
          path: t.path,
          kind: "full",
          copyOnly: false,
          checksum: true,
          compression: true,
        });
      case "history":
        if (!Number.isInteger(t.days) || t.days < 1)
          throw new Error("History retention must be positive.");
        return `DECLARE @cutoff datetime=DATEADD(day,-${t.days},GETDATE()); EXEC msdb.dbo.sp_delete_backuphistory @oldest_date=@cutoff; EXEC msdb.dbo.sp_purge_jobhistory @oldest_date=@cutoff;`;
      case "sql":
        if (!t.sql.trim()) throw new Error("A custom SQL task is empty.");
        return t.sql;
    }
  }
  const steps = tasks
    .map(
      (t, i) =>
        `EXEC msdb.dbo.sp_add_jobstep @job_id=@job, @step_id=${i + 1}, @step_name=${l(`${i + 1}. ${t.kind}`)}, @subsystem=N'TSQL', @database_name=${l(database)}, @command=${l(taskSql(t))}, @on_success_action=${t.nextSuccess ? 4 : i === tasks.length - 1 ? 1 : 3}${t.nextSuccess ? `, @on_success_step_id=${ids.get(t.nextSuccess)}` : ""}, @on_fail_action=${t.nextFailure ? 4 : 2}${t.nextFailure ? `, @on_fail_step_id=${ids.get(t.nextFailure)}` : ""};`,
    )
    .join("\n");
  // msdb procedures report failures with RAISERROR, which XACT_ABORT does not
  // turn into a rollback; TRY/CATCH does, so a failed step leaves no half job.
  return transactional(
    `DECLARE @job uniqueidentifier;\nEXEC msdb.dbo.sp_add_job @job_name=${l(name)}, @enabled=1, @description=N'Quervio maintenance flow', @job_id=@job OUTPUT;\n${steps}\nEXEC msdb.dbo.sp_add_jobschedule @job_id=@job, @name=${l(name + " daily")}, @freq_type=4, @freq_interval=1, @active_start_time=${hour * 10000 + minute * 100};\nEXEC msdb.dbo.sp_add_jobserver @job_id=@job;`,
  );
}

export function queryStoreAction(
  queryId: string,
  planId: string,
  force: boolean,
) {
  if (!/^\d+$/.test(queryId) || !/^\d+$/.test(planId))
    throw new Error("Select a query and plan.");
  return `EXEC sys.${force ? "sp_query_store_force_plan" : "sp_query_store_unforce_plan"} @query_id=${queryId}, @plan_id=${planId};`;
}
