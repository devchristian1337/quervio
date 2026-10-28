import { useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { api, errorMessage } from "@/lib/api";
import {
  management,
  type Context,
  type DataTable,
  type OperationPreview,
  type Progress,
  type Resource,
} from "@/lib/management-api";
import { useQueries } from "@/stores/queries";
import { invalidateCatalog } from "@/lib/metadata-events";
import {useOperations} from "@/stores/operations";

export const inputClass =
  "h-8 min-w-0 rounded border border-input bg-background px-2 text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring";
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
      <span>{label}</span>
      {children}
    </label>
  );
}
export function Text({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  return (
    <Field label={label}>
      <input
        type={type}
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
export function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly (T | readonly [T, string])[];
}) {
  return (
    <Field label={label}>
      <select
        className={inputClass}
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
      >
        {options.map((option) => {
          const [key, name] =
            typeof option === "string" ? [option, option] : option;
          return (
            <option key={key} value={key}>
              {name}
            </option>
          );
        })}
      </select>
    </Field>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      role={error ? "alert" : "status"}
      className={`rounded border p-3 text-sm whitespace-pre-wrap select-text ${error ? "text-destructive" : "text-muted-foreground"}`}
    >
      {children}
    </div>
  );
}

export function DataGrid({
  data,
  onRow,
  selected,
}: {
  data: DataTable;
  onRow?: (row: Record<string, string | null>) => void;
  selected?: (row: Record<string, string | null>) => boolean;
}) {
  const numeric=useMemo(()=>data.columns.map((_,index)=>data.rows.some(row=>row[index]!==null) && data.rows.every(row=>row[index]===null || /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(row[index]??""))),[data]);
  return (
    <div className="max-h-96 shrink-0 overflow-auto rounded border">
      <table className="w-full border-collapse text-xs">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {data.columns.map((c, i) => (
              <th
                key={i}
                className={`border-b px-3 py-2 font-medium whitespace-nowrap ${numeric[i]?"text-right":"text-left"}`}
              >
                {c.replace(/_/g, " ")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, index) => {
            const record = Object.fromEntries(
              data.columns.map((c, i) => [c, row[i]]),
            );
            return (
              <tr
                key={index}
                tabIndex={onRow ? 0 : undefined}
                onClick={() => onRow?.(record)}
                onKeyDown={(e) => e.key === "Enter" && onRow?.(record)}
                className={`border-b last:border-0 ${onRow ? "cursor-pointer hover:bg-accent/50" : ""} ${selected?.(record) ? "bg-accent" : ""}`}
              >
                {row.map((v, i) => (
                  <td
                    key={i}
                    className={`max-w-lg truncate px-3 py-2 select-text ${numeric[i]?"text-right tabular-nums":""} ${v === null ? "text-muted-foreground" : ""}`}
                    title={v ?? "NULL"}
                  >
                    {v ?? "NULL"}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      {data.rows.length === 0 && (
        <p className="p-3 text-xs text-muted-foreground">No rows returned.</p>
      )}
      {data.truncated && (
        <p className="p-2 text-xs text-muted-foreground">
          Showing the first {data.rows.length} rows.
        </p>
      )}
    </div>
  );
}

export function useRead(
  context: Context,
  resource: Resource | null,
  refreshSeconds = 0,
) {
  const [data, setData] = useState<DataTable | null>(null),
    [error, setError] = useState<string | null>(null),
    [loading, setLoading] = useState(false),
    [updated, setUpdated] = useState<Date | null>(null),
    [revision, revise] = useState(0);
  const resourceKey = JSON.stringify(resource);
  useEffect(() => {
    if (!resource) {
      setData(null);
      return;
    }
    if (context.active === false) return;
    let disposed = false,
      busy = false;
    async function load() {
      if (busy || document.hidden) return;
      busy = true;
      setLoading(true);
      try {
        const table = await management.read(context, JSON.parse(resourceKey));
        if (!disposed) {
          setData(table);
          setError(null);
          setUpdated(new Date());
        }
      } catch (e) {
        if (!disposed) setError(errorMessage(e));
      } finally {
        busy = false;
        if (!disposed) setLoading(false);
      }
    }
    void load();
    const visibility = () => {
      if (!document.hidden) void load();
    };
    document.addEventListener("visibilitychange", visibility);
    const timer = refreshSeconds
      ? window.setInterval(() => void load(), refreshSeconds * 1000)
      : null;
    return () => {
      disposed = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
    };
    // resourceKey is the stable representation of the typed resource.
  }, [
    context.connectionId,
    context.database,
    context.active,
    resourceKey,
    refreshSeconds,
    revision,
  ]);
  return { data, error, loading, updated, refresh: () => revise((v) => v + 1) };
}

export function ReadTable({
  context,
  resource,
  refreshSeconds = 0,
  onRow,
}: {
  context: Context;
  resource: Resource;
  refreshSeconds?: number;
  onRow?: (row: Record<string, string | null>) => void;
}) {
  const result = useRead(context, resource, refreshSeconds);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Button
          size="sm"
          variant="outline"
          disabled={result.loading}
          onClick={result.refresh}
        >
          {result.loading ? "Loading…" : "Refresh"}
        </Button>
        {result.updated && (
          <span>Updated {result.updated.toLocaleTimeString()}</span>
        )}
      </div>
      {result.error && <Notice error>{result.error}</Notice>}
      {result.data && <DataGrid data={result.data} onRow={onRow} />}
    </div>
  );
}

export function Operation({
  context,
  script,
  label = "Preview operation",
  onApplied,
}: {
  context: Context;
  script: string;
  label?: string;
  onApplied?: () => void;
}) {
  const [preview, setPreview] = useState<OperationPreview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [progress, setProgress] = useState(""),
    [done, setDone] = useState(false);
  const tokenRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (tokenRef.current) void management.discard(tokenRef.current);
    },
    [],
  );
  async function prepare() {
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const value = await management.prepare(context, script);
      tokenRef.current = value.token;
      setPreview(value);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!preview) return;
    useOperations.getState().begin(preview.token,label);
    setBusy(true);
    setError(null);
    try {
      const messages = await management.apply(preview.token, (e) =>
        setProgress(e.message),
      );
      tokenRef.current = null;
      setDone(true);
      invalidateCatalog();
      setProgress(
        messages.join("\n") ||
          "Operation completed. Refresh to verify the server state.",
      );
      onApplied?.();
    } catch (e) {
      tokenRef.current = null;
      setError(errorMessage(e));
    } finally {
      useOperations.getState().end(preview.token);
      setBusy(false);
    }
  }
  const close = () => {
    if (busy) return;
    if (tokenRef.current) void management.discard(tokenRef.current);
    tokenRef.current = null;
    setPreview(null);
  };
  return (
    <>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          disabled={busy || !script.trim()}
          onClick={() => void prepare()}
          variant="outline"
        >
          {label}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!script.trim()}
          onClick={() =>
            void useQueries
              .getState()
              .open(context.connectionId, context.database, {
                text: script,
                dirty: true,
              })
          }
        >
          Open script
        </Button>
      </div>
      {error && !preview && <Notice error>{error}</Notice>}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && close()}>
        <DialogContent
          className="flex max-h-[90vh] max-w-4xl flex-col"
          onInteractOutside={(e) => busy && e.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>
              {done ? "Operation completed" : "Confirm server operation"}
            </DialogTitle>
            <DialogDescription>
              {preview?.server} · {preview?.database} · Preview expires after
              five minutes
            </DialogDescription>
          </DialogHeader>
          <pre className="min-h-0 flex-1 overflow-auto rounded border bg-background p-3 text-xs select-text">
            {preview?.script}
          </pre>
          {progress && <Notice>{progress}</Notice>}
          {error && <Notice error>{error}</Notice>}
          <DialogFooter>
            {busy && preview && (
              <Button
                variant="outline"
                onClick={() => void management.cancel(preview.token)}
              >
                Cancel operation
              </Button>
            )}
            <Button variant="outline" disabled={busy} onClick={close}>
              Close
            </Button>
            {!done && !error && (
              <Button disabled={busy} onClick={() => void apply()}>
                {busy ? "Executing…" : "Confirm and execute"}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function BridgeOperation({
  context,
  action,
  args,
  write = false,
  label,
  onResult,
}: {
  context: Context;
  action: string;
  args: Record<string, unknown>;
  write?: boolean;
  label: string;
  onResult?: (result: unknown) => void;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null),
    [progress, setProgress] = useState(""),
    [result, setResult] = useState<unknown>(null);
  const [prepared, setPrepared] = useState<{
    token: string;
    server: string;
    database: string;
    args: Record<string, unknown>;
    context: Context;
  } | null>(null);
  const preparedToken = useRef<string | null>(null);
  const runningToken = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (preparedToken.current) void management.discard(preparedToken.current);
    },
    [],
  );
  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      const preview = await management.bridgePrepare(context, action, args);
      preparedToken.current = preview.token;
      setPrepared({
        ...preview,
        args: structuredClone(args),
        context: { ...context },
      });
      setConfirm(true);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  function close() {
    if (busy) return;
    if (preparedToken.current) void management.discard(preparedToken.current);
    preparedToken.current = null;
    setPrepared(null);
    setConfirm(false);
  }
  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    const operationId = prepared?.token ?? crypto.randomUUID();
    useOperations.getState().begin(operationId,label);
    runningToken.current = operationId;
    try {
      const value = await management.bridge(
        prepared?.context ?? context,
        action,
        prepared?.args ?? args,
        write,
        (event: Progress) =>
          setProgress(
            event.message +
              (event.completed !== null ? ` · ${event.completed} rows` : ""),
          ),
        operationId,
      );
      preparedToken.current = null;
      setPrepared(null);
      setResult(value);
      if (write) invalidateCatalog();
      onResult?.(value);
      setConfirm(false);
    } catch (e) {
      preparedToken.current = null;
      setPrepared(null);
      setError(errorMessage(e));
    } finally {
      if(runningToken.current)useOperations.getState().end(runningToken.current);
      runningToken.current = null;
      setBusy(false);
    }
  }
  return (
    <>
      <Button
        size="sm"
        disabled={busy}
        onClick={() => (write ? void prepare() : void run())}
        variant={write?"default":"outline"}
      >
        {busy ? "Working…" : label}
      </Button>
      {busy && runningToken.current && (
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            runningToken.current && void management.cancel(runningToken.current)
          }
        >
          Cancel operation
        </Button>
      )}
      {progress && <Notice>{progress}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {result !== null && !onResult && (
        <pre className="max-h-72 overflow-auto rounded border p-3 text-xs select-text">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
      <Dialog open={confirm} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {prepared?.server} · {prepared?.database}. Review the destination
              and options before applying.
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto p-2 text-xs select-text">
            {JSON.stringify(
              Object.fromEntries(
                Object.entries(prepared?.args ?? args).filter(
                  ([k]) => !/password|secret|sourceConnection/i.test(k),
                ),
              ),
              null,
              2,
            )}
          </pre>
          {error && <Notice error>{error}</Notice>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={close}>
              Cancel
            </Button>
            <Button disabled={busy || !prepared} onClick={() => void run()}>
              {busy ? "Working…" : "Confirm and execute"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export async function saveText(path: string, text: string) {
  await api.fileWrite(path, text);
}
