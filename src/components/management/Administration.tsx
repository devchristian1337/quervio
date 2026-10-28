import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { api, errorMessage } from "@/lib/api";
import { quoteName as n, sqlLiteral as l, type Context } from "@/lib/management-api";
import {
  backupScript,
  maintenanceScript,
  restoreScript,
  validateRestoreChain,
  type MaintenanceTask,
  type RestoreSource,
} from "@/lib/sql-management";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  BridgeOperation,
  Check,
  Choice,
  DataGrid,
  Notice,
  Operation,
  ReadTable,
  Text,
  textareaClass,
  useRead,
  ViewTabs,
} from "./shared";

export function BackupRestore({
  context,
  azure,
}: {
  context: Context;
  azure: boolean;
}) {
  const [historyRevision, setHistoryRevision] = useState(0);
  const [mode, setMode] = useState("backup"),
    [kind, setKind] = useState<"full" | "differential" | "log">("full"),
    [path, setPath] = useState(""),
    [inspectedPath, setInspectedPath] = useState(""),
    [copyOnly, setCopyOnly] = useState(false),
    [compression, setCompression] = useState(false),
    [checksum, setChecksum] = useState(true);
  const [target, setTarget] = useState(""),
    [stopAt, setStopAt] = useState(""),
    [recover, setRecover] = useState(true),
    [replace, setReplace] = useState(false),
    [disconnect, setDisconnect] = useState(false),
    [sources, setSources] = useState<RestoreSource[]>([]),
    [moves, setMoves] = useState<{ logical: string; physical: string }[]>([]);
  const [resourceId, setResourceId] = useState(""),
    [targetResourceId, setTargetResourceId] = useState(""),
    [retention, setRetention] = useState("7");
  let script = "",
    validation = "";
  try {
    if (!azure && context.database) {
      if (mode === "backup" && path)
        script = backupScript({
          database: context.database,
          path,
          kind,
          copyOnly,
          compression,
          checksum,
        });
      if (mode === "restore" && target && sources.length) {
        validateRestoreChain(sources);
        script = restoreScript(
          target,
          sources,
          stopAt,
          moves,
          recover,
          replace,
        );
        // Otherwise the restore waits for every session using the database to leave.
        if (disconnect)
          script = `IF DB_ID(${l(target)}) IS NOT NULL ALTER DATABASE ${n(target)} SET SINGLE_USER WITH ROLLBACK IMMEDIATE;\n${script}`;
      }
      if (mode === "verify" && path)
        script = `RESTORE VERIFYONLY FROM ${path.startsWith("https://") ? "URL" : "DISK"}=${l(path)};`;
    }
  } catch (e) {
    validation = errorMessage(e);
  }
  if (azure)
    return (
      <div className="flex flex-col gap-3 overflow-auto">
        <Notice>
          Azure SQL Database uses managed backups. Restore creates a separate
          database through Azure Resource Manager.
        </Notice>
        <Text
          label="Source Azure SQL database resource ID"
          value={resourceId}
          onChange={setResourceId}
        />
        <BridgeOperation
          context={context}
          action="azureBackups"
          args={{ resourceId }}
          label="Read retention policies"
        />
        <Text
          label="New destination database resource ID"
          value={targetResourceId}
          onChange={setTargetResourceId}
        />
        <Text
          label="Restore point (with time zone)"
          value={stopAt}
          onChange={setStopAt}
        />
        <BridgeOperation
          context={context}
          action="azureRestore"
          args={{ resourceId, targetResourceId, pointInTime: stopAt }}
          label="Restore to new Azure database"
          write
        />
        <Text
          label="Short-term retention days"
          value={retention}
          onChange={setRetention}
          type="number"
        />
        <BridgeOperation
          context={context}
          action="azureRetention"
          args={{ resourceId, days: Number(retention) }}
          label="Change retention"
          write
        />
        <BridgeOperation
          context={context}
          action="azureList"
          args={{ resourceId: targetResourceId || resourceId }}
          label="Check resource provisioning status"
        />
      </div>
    );
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <ViewTabs
        label="Operation"
        value={mode}
        onChange={setMode}
        options={[
          ["backup", "Backup"],
          ["restore", "Restore chain"],
          ["verify", "Verify backup media"],
        ]}
      />
      <Notice>
        Paths refer to the SQL Server host or Azure Storage, and must be
        accessible to the SQL Server service account.
      </Notice>
      <Text
        label="Server-side backup path or Azure Blob URL"
        value={path}
        onChange={setPath}
      />
      {mode === "backup" && (
        <>
          <Choice
            label="Backup type"
            value={kind}
            onChange={(v) => {
              setKind(v);
              if (v === "differential") setCopyOnly(false);
            }}
            options={[
              ["full", "Full"],
              ["differential", "Differential"],
              ["log", "Transaction log"],
            ]}
          />
          <div className="flex gap-4 text-sm">
            <Check
              label="Copy-only"
              checked={copyOnly}
              disabled={kind === "differential"}
              onChange={setCopyOnly}
            />
            <Check
              label="Compression"
              checked={compression}
              onChange={setCompression}
            />
            <Check
              label="Checksum"
              checked={checksum}
              onChange={setChecksum}
            />
          </div>
        </>
      )}
      <Button
        variant="outline"
        className="self-start"
        disabled={!path}
        onClick={() => setInspectedPath(path)}
      >
        Inspect backup media
      </Button>
      {inspectedPath && (
        <>
          <h2 className="border-b pb-2 text-sm font-medium">Backup media headers</h2>
          <ReadTable
            context={context}
            resource={{ kind: "backupHeader", path: inspectedPath }}
            onRow={(row) => {
              setSources((s) => [
                ...s,
                {
                  path: inspectedPath,
                  position: Number(row.Position) || 1,
                  kind: row.BackupType === "2" ? "log" : "database",
                  firstLsn: row.FirstLSN ?? undefined,
                  lastLsn: row.LastLSN ?? undefined,
                  checkpointLsn: row.CheckpointLSN ?? undefined,
                  databaseBackupLsn: row.DatabaseBackupLSN ?? undefined,
                  backupType: Number(row.BackupType),
                  databaseName: row.DatabaseName ?? undefined,
                  recoveryFork: row.RecoveryForkID ?? undefined,
                },
              ]);
            }}
          />
          <h2 className="border-b pb-2 text-sm font-medium">
            Logical files · select a file to map its destination
          </h2>
          <ReadTable
            context={context}
            resource={{ kind: "backupFiles", path: inspectedPath }}
            onRow={(row) =>
              setMoves((m) => [
                ...m.filter((v) => v.logical !== row.LogicalName),
                {
                  logical: row.LogicalName ?? "",
                  physical: row.PhysicalName ?? "",
                },
              ])
            }
          />
        </>
      )}
      {mode === "restore" && (
        <>
          <Text
            label="Destination database (existing database replacement is off by default)"
            value={target}
            onChange={setTarget}
          />
          <Notice>
            Select backup headers in restore order: full, optional differential,
            transaction logs. SQL Server validates LSN continuity during
            restore; execution stops at the first invalid backup.
          </Notice>
          {sources.map((source, index) => (
            <div key={index} className="flex items-end gap-2">
              <span className="text-xs">
                {index + 1}. {source.kind} · media {source.position} ·{" "}
                {source.path}
              </span>
              <Button
                variant="ghost"
                onClick={() =>
                  setSources((s) => s.filter((_, i) => i !== index))
                }
              >
                Remove
              </Button>
            </div>
          ))}
          {moves.map((move, index) => (
            <Text
              key={index}
              label={`MOVE ${move.logical} to server file`}
              value={move.physical}
              onChange={(physical) =>
                setMoves((m) =>
                  m.map((v, i) => (i === index ? { ...v, physical } : v)),
                )
              }
            />
          ))}
          <Text
            label="STOPAT (server local time, optional)"
            value={stopAt}
            onChange={setStopAt}
            type="datetime-local"
          />
          <div className="flex gap-4 text-sm">
            <Check
              label="Recover final backup"
              checked={recover}
              onChange={setRecover}
            />
            <Check
              label="WITH REPLACE: overwrite destination"
              checked={replace}
              onChange={setReplace}
            />
            <Check
              label="Disconnect other sessions and roll back their transactions"
              checked={disconnect}
              onChange={setDisconnect}
            />
          </div>
        </>
      )}
      {validation && <Notice error>{validation}</Notice>}
      <Operation
        context={mode === "restore" ? { ...context, database: "master" } : context}
        script={script}
        label="Preview backup / restore"
        onApplied={() => setHistoryRevision((value) => value + 1)}
      />
      <h2 className="border-b pb-2 text-sm font-medium">
        Backup history for {context.database}
      </h2>
      {/* Read again after each backup or restore. */}
      <ReadTable key={historyRevision} context={context} resource={{ kind: "backups" }} />
    </div>
  );
}

export function Agent({ context }: { context: Context }) {
  const [section, setSection] = useState("jobs"),
    [jobId, setJobId] = useState(""),
    [name, setName] = useState(""),
    [command, setCommand] = useState(""),
    [stepName, setStepName] = useState(""),
    [stepId, setStepId] = useState("1"),
    [mode, setMode] = useState("create"),
    [enabled, setEnabled] = useState(true);
  const [schedule, setSchedule] = useState(""),
    [scheduleId, setScheduleId] = useState(""),
    [frequency, setFrequency] = useState("4"),
    [time, setTime] = useState("02:00"),
    [interval, setInterval] = useState("1"),
    [email, setEmail] = useState(""),
    [severity, setSeverity] = useState("16"),
    [messageId, setMessageId] = useState("0"),
    [operator, setOperator] = useState("");
  const data = useRead(context, {
    kind: section as "jobs" | "alerts" | "operators",
  });
  let script = "";
  if (name) {
    if (section === "jobs")
      script =
        mode === "create"
          ? `DECLARE @job uniqueidentifier;\nEXEC msdb.dbo.sp_add_job @job_name=${l(name)},@enabled=${enabled ? 1 : 0},@job_id=@job OUTPUT;\nEXEC msdb.dbo.sp_add_jobserver @job_id=@job;`
          : mode === "update"
            ? `EXEC msdb.dbo.sp_update_job @job_name=${l(name)},@enabled=${enabled ? 1 : 0};`
            : `EXEC msdb.dbo.sp_${mode}_job @job_name=${l(name)};`;
    if (section === "operators")
      script =
        mode === "delete"
          ? `EXEC msdb.dbo.sp_delete_operator @name=${l(name)};`
          : `EXEC msdb.dbo.sp_${mode === "update" ? "update" : "add"}_operator @name=${l(name)},@enabled=${enabled ? 1 : 0},@email_address=${l(email)};`;
    if (
      section === "alerts" &&
      /^\d+$/.test(severity) &&
      /^\d+$/.test(messageId)
    )
      script =
        mode === "delete"
          ? `EXEC msdb.dbo.sp_delete_alert @name=${l(name)};`
          : `EXEC msdb.dbo.sp_${mode === "update" ? "update" : "add"}_alert @name=${l(name)},@enabled=${enabled ? 1 : 0},@message_id=${messageId},@severity=${severity},@delay_between_responses=60;${operator ? `\nIF EXISTS (SELECT 1 FROM msdb.dbo.sysnotifications s JOIN msdb.dbo.sysalerts a ON a.id=s.alert_id JOIN msdb.dbo.sysoperators o ON o.id=s.operator_id WHERE a.name=${l(name)} AND o.name=${l(operator)})\n  EXEC msdb.dbo.sp_update_notification @alert_name=${l(name)},@operator_name=${l(operator)},@notification_method=1;\nELSE\n  EXEC msdb.dbo.sp_add_notification @alert_name=${l(name)},@operator_name=${l(operator)},@notification_method=1;` : ""}`;
  }
  const validStep = /^\d+$/.test(stepId) && Number(stepId) > 0;
  const stepScript =
    jobId && stepName && validStep
      ? `EXEC msdb.dbo.sp_${mode === "update" ? "update" : mode === "delete" ? "delete" : "add"}_jobstep @job_id=${l(jobId)},@step_id=${stepId}${mode === "delete" ? "" : `,@step_name=${l(stepName)},@subsystem=N'TSQL',@database_name=${l(context.database ?? "master")},@command=${l(command)}${mode === "update" ? "" : ",@on_success_action=1"},@on_fail_action=2`};${mode !== "update" && mode !== "delete" ? `${Number(stepId) > 1 ? `\nEXEC msdb.dbo.sp_update_jobstep @job_id=${l(jobId)},@step_id=${Number(stepId) - 1},@on_success_action=3;` : ""}\nIF EXISTS (SELECT 1 FROM msdb.dbo.sysjobsteps WHERE job_id=${l(jobId)} AND step_id>${Number(stepId)}) EXEC msdb.dbo.sp_update_jobstep @job_id=${l(jobId)},@step_id=${Number(stepId)},@on_success_action=3;` : ""}`
      : "";
  const validSchedule =
    /^\d+$/.test(interval) && Number(interval) > 0 && /^\d\d:\d\d$/.test(time);
  const scheduleScript =
    jobId && schedule && validSchedule
      ? mode === "delete" && /^\d+$/.test(scheduleId)
        ? `EXEC msdb.dbo.sp_detach_schedule @job_id=${l(jobId)},@schedule_id=${scheduleId};`
        : mode === "update" && /^\d+$/.test(scheduleId)
          ? `EXEC msdb.dbo.sp_update_schedule @schedule_id=${scheduleId},@new_name=${l(schedule)},@enabled=${enabled ? 1 : 0},@freq_type=${frequency},@freq_interval=${interval},@freq_recurrence_factor=1,@active_start_time=${Number(time.replace(":", "")) * 100};`
          : `EXEC msdb.dbo.sp_add_jobschedule @job_id=${l(jobId)},@name=${l(schedule)},@enabled=${enabled ? 1 : 0},@freq_type=${frequency},@freq_interval=${interval},@freq_recurrence_factor=1,@active_start_time=${Number(time.replace(":", "")) * 100};`
      : "";
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <ViewTabs
        label="Agent objects"
        value={section}
        onChange={setSection}
        options={[
          ["jobs", "Jobs"],
          ["alerts", "Alerts"],
          ["operators", "Operators"],
        ]}
      />
      {data.error && <Notice error>{data.error}</Notice>}
      {data.data && (
        <DataGrid
          data={data.data}
          onRow={(row) => {
            setName(row.name ?? "");
            setJobId(row.job_id ?? "");
            setEnabled(row.enabled === "1");
            setEmail(row.email_address ?? "");
            setMode("update");
          }}
        />
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label="Operation"
          value={mode}
          onChange={setMode}
          options={
            section === "jobs"
              ? ["create", "update", "start", "stop", "delete"]
              : ["create", "update", "delete"]
          }
        />
        <Text label="Name" value={name} onChange={setName} />
        <Check
          label="Enabled"
          checked={enabled}
          onChange={setEnabled}
        />
        {section === "operators" && (
          <Text label="Email address" value={email} onChange={setEmail} />
        )}
        {section === "alerts" && (
          <>
            <Text
              label="Severity (0 when using message ID)"
              value={severity}
              onChange={setSeverity}
              type="number"
            />
            <Text
              label="Message ID (0 when using severity)"
              value={messageId}
              onChange={setMessageId}
              type="number"
            />
            <Text
              label="Notify operator (email)"
              value={operator}
              onChange={setOperator}
            />
          </>
        )}
        <Operation
          context={context}
          script={script}
          label="Preview Agent operation"
          onApplied={data.refresh}
        />
      </div>
      {section === "jobs" && jobId && (
        <>
          <h2 className="border-b pb-2 text-sm font-medium">Job steps</h2>
          <ReadTable
            context={context}
            resource={{ kind: "jobSteps", jobId }}
            onRow={(row) => {
              setStepId(row.step_id ?? "1");
              setStepName(row.step_name ?? "");
              setCommand(row.command ?? "");
              setMode("update");
            }}
          />
          <div className="grid grid-cols-2 gap-3">
            <Text
              label="Step ID"
              value={stepId}
              onChange={setStepId}
              type="number"
            />
            <Text label="Step name" value={stepName} onChange={setStepName} />
          </div>
          <textarea
            aria-label="T-SQL job step"
            className={cn(textareaClass, "min-h-32")}
            value={command}
            onChange={(e) => setCommand(e.target.value)}
          />
          <Operation
            context={context}
            script={stepScript}
            label="Preview job step"
          />
          <h2 className="border-b pb-2 text-sm font-medium">Schedule</h2>
          <div className="grid grid-cols-3 gap-3">
            <Text
              label="Schedule ID (update/detach)"
              value={scheduleId}
              onChange={setScheduleId}
              type="number"
            />
            <Text
              label="Schedule name"
              value={schedule}
              onChange={setSchedule}
            />
            <Choice
              label="Frequency"
              value={frequency}
              onChange={setFrequency}
              options={[
                ["4", "Daily"],
                ["8", "Weekly"],
                ["16", "Monthly"],
              ]}
            />
            <Text
              label={
                frequency === "8"
                  ? "Weekday bitmask (1=Sun, 2=Mon, …, 64=Sat)"
                  : frequency === "16"
                    ? "Day of month"
                    : "Every N days"
              }
              value={interval}
              onChange={setInterval}
              type="number"
            />
            <Text
              label="Start time (server local time)"
              value={time}
              onChange={setTime}
              type="time"
            />
          </div>
          <Operation
            context={context}
            script={scheduleScript}
            label="Preview schedule"
          />
          <h2 className="border-b pb-2 text-sm font-medium">Execution history</h2>
          <ReadTable
            context={context}
            resource={{ kind: "jobHistory", jobId }}
          />
        </>
      )}
    </div>
  );
}

function newTask(): MaintenanceTask {
  return {
    id: crypto.randomUUID(),
    kind: "statistics",
    schema: "dbo",
    table: "",
    path: "",
    sql: "",
    days: 30,
  };
}
export function Maintenance({
  context,
  agentAvailable,
}: {
  context: Context;
  agentAvailable: boolean;
}) {
  const [name, setName] = useState(""),
    [time, setTime] = useState("02:00"),
    [tasks, setTasks] = useState<MaintenanceTask[]>([newTask()]),
    [selected, setSelected] = useState(0),
    [error, setError] = useState<string | null>(null),
    [replace, setReplace] = useState(false);
  const dragged = useRefIndex();
  const task = tasks[selected];
  function change(patch: Partial<MaintenanceTask>) {
    setTasks((values) =>
      values.map((t, i) => (i === selected ? { ...t, ...patch } : t)),
    );
  }
  let script = "",
    validation = "";
  try {
    if (name && context.database) {
      const [hour, minute] = time.split(":").map(Number);
      script = maintenanceScript(name, context.database, tasks, hour, minute);
      if (replace)
        script =
          `IF EXISTS(SELECT 1 FROM msdb.dbo.sysjobs WHERE name=${l(name)}) EXEC msdb.dbo.sp_delete_job @job_name=${l(name)},@delete_unused_schedule=1;\n` +
          script;
    }
  } catch (e) {
    validation = errorMessage(e);
  }
  async function file(importing: boolean) {
    try {
      if (importing) {
        const path = await open({
          multiple: false,
          filters: [{ name: "Quervio maintenance flow", extensions: ["json"] }],
        });
        if (path) {
          const value = JSON.parse(await api.fileRead(path));
          if (value.version !== 1 || !Array.isArray(value.tasks))
            throw new Error("Unsupported maintenance flow format.");
          maintenanceScript(
            value.name,
            context.database ?? "master",
            value.tasks,
            2,
            0,
          );
          setName(value.name);
          setTasks(value.tasks);
          setTime(value.time);
          setSelected(0);
        }
      } else {
        const path = await save({
          defaultPath: name
            ? `${name}.quervio-maintenance.json`
            : "maintenance.quervio.json",
        });
        if (path)
          await api.fileWrite(
            path,
            JSON.stringify({ version: 1, name, time, tasks }, null, 2),
          );
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap items-end gap-3">
        <Text label="Agent job name" value={name} onChange={setName} />
        <Text
          label="Daily start (server local time)"
          value={time}
          onChange={setTime}
          type="time"
        />
        <Button variant="outline" onClick={() => void file(false)}>
          Save flow
        </Button>
        <Button variant="outline" onClick={() => void file(true)}>
          Open flow
        </Button>
      </div>
      <Notice>
        Drag tasks to arrange their default execution order. Success and failure
        targets override that order. The deployed job runs on SQL Server Agent
        while Quervio is closed.
      </Notice>
      <div className="grid min-h-72 grid-cols-[minmax(220px,1fr)_2fr] gap-3">
        <div className="flex flex-col gap-2 rounded-md border p-3">
          {tasks.map((item, index) => (
            <button
              key={item.id}
              draggable
              onDragStart={() => {
                dragged.current = index;
              }}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const start = dragged.current;
                if (start === null) return;
                setTasks((values) => {
                  const next = [...values];
                  const [value] = next.splice(start, 1);
                  next.splice(index, 0, value);
                  return next;
                });
                setSelected(index);
                dragged.current = null;
              }}
              onClick={() => setSelected(index)}
              className={`rounded-md border px-3 py-3 text-left text-sm ${selected === index ? "border-primary bg-accent" : "bg-panel"}`}
            >
              <span className="mr-2 text-muted-foreground">{index + 1}</span>
              {item.kind}
              {item.table && ` · ${item.schema}.${item.table}`}
              <span className="block pt-1 text-xs text-muted-foreground">
                Success →{" "}
                {item.nextSuccess
                  ? tasks.findIndex((t) => t.id === item.nextSuccess) + 1
                  : index === tasks.length - 1
                    ? "Complete"
                    : "Next"}{" "}
                · Failure →{" "}
                {item.nextFailure
                  ? tasks.findIndex((t) => t.id === item.nextFailure) + 1
                  : "Fail job"}
              </span>
            </button>
          ))}
          <Button
            variant="outline"
            onClick={() => {
              setTasks((t) => [...t, newTask()]);
              setSelected(tasks.length);
            }}
          >
            Add task
          </Button>
        </div>
        {task && (
          <div className="flex flex-col gap-3">
            <Choice
              label="Task"
              value={task.kind}
              onChange={(kind) => change({ kind })}
              options={[
                ["reorganize", "Reorganize indexes"],
                ["rebuild", "Rebuild indexes"],
                ["statistics", "Update statistics"],
                ["backup", "Full backup"],
                ["history", "Clean history"],
                ["sql", "Custom T-SQL"],
              ]}
            />
            {["reorganize", "rebuild", "statistics"].includes(task.kind) && (
              <>
                <Text
                  label="Schema"
                  value={task.schema}
                  onChange={(schema) => change({ schema })}
                />
                <Text
                  label="Table"
                  value={task.table}
                  onChange={(table) => change({ table })}
                />
              </>
            )}
            {task.kind === "backup" && (
              <Text
                label="Server-side backup path"
                value={task.path}
                onChange={(path) => change({ path })}
              />
            )}
            {task.kind === "history" && (
              <Text
                label="Retain days"
                value={String(task.days)}
                onChange={(days) => change({ days: Number(days) })}
                type="number"
              />
            )}
            {task.kind === "sql" && (
              <textarea
                aria-label="Maintenance T-SQL"
                className={cn(textareaClass, "min-h-32")}
                value={task.sql}
                onChange={(e) => change({ sql: e.target.value })}
              />
            )}
            <Choice
              label="On success"
              value={task.nextSuccess ?? ""}
              onChange={(id) => change({ nextSuccess: id || undefined })}
              options={[
                ["", "Next task / complete"],
                ...tasks
                  .filter((t) => t.id !== task.id)
                  .map(
                    (t) =>
                      [t.id, `${tasks.indexOf(t) + 1}. ${t.kind}`] as const,
                  ),
              ]}
            />
            <Choice
              label="On failure"
              value={task.nextFailure ?? ""}
              onChange={(id) => change({ nextFailure: id || undefined })}
              options={[
                ["", "Fail job"],
                ...tasks
                  .filter((t) => t.id !== task.id)
                  .map(
                    (t) =>
                      [t.id, `${tasks.indexOf(t) + 1}. ${t.kind}`] as const,
                  ),
              ]}
            />
            <Button
              variant="outline"
              onClick={() => {
                setTasks((values) =>
                  values
                    .filter((t) => t.id !== task.id)
                    .map((t) => ({
                      ...t,
                      nextSuccess:
                        t.nextSuccess === task.id ? undefined : t.nextSuccess,
                      nextFailure:
                        t.nextFailure === task.id ? undefined : t.nextFailure,
                    })),
                );
                setSelected(0);
              }}
            >
              Remove task
            </Button>
          </div>
        )}
      </div>
      <Check
        label="Replace an existing job with the same name"
        checked={replace}
        onChange={setReplace}
      />
      {validation && <Notice error>{validation}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {agentAvailable ? (
        <Operation
          context={context}
          script={script}
          label="Preview Agent deployment"
        />
      ) : (
        <>
          <Notice>
            SQL Server Agent is unavailable. Save the flow or open its generated
            SQL script.
          </Notice>
          <Button
            variant="outline"
            disabled={!script}
            onClick={() => void saveScript(script)}
          >
            Export deployment script
          </Button>
        </>
      )}
    </div>
  );
}

function useRefIndex() {
  const [ref] = useState<{ current: number | null }>({ current: null });
  return ref;
}
async function saveScript(script: string) {
  const path = await save({ defaultPath: "maintenance.sql" });
  if (path) await api.fileWrite(path, script);
}
