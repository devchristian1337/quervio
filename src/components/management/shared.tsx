import { useEffect, useId, useRef, useState, useMemo, type ReactNode } from "react";
import { Info, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/interfaces-select";
import { cn } from "@/lib/utils";
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

// The app's controls (ui/input, ui/interfaces-select, ui/checkbox), so the
// tools look like the connection dialog and Settings: 36px fields, labels
// in the text colour above them.
export const inputClass =
  "h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs transition-[color,box-shadow] outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive";
/** A script or JSON editor: the field's border and focus, in the code face. */
export const textareaClass =
  "w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-xs transition-[color,box-shadow] outline-none select-text placeholder:text-muted-foreground disabled:opacity-50 dark:bg-input/30 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";
/** Read-only scripts and results. */
export const codeClass =
  "overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-xs whitespace-pre select-text";

export function Field({
  label,
  htmlFor,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  if (htmlFor)
    return (
      <div className={cn("grid min-w-0 content-start gap-1.5", className)}>
        <Label htmlFor={htmlFor}>{label}</Label>
        {children}
      </div>
    );
  // Wrapping the control names it for controls that cannot take an id.
  return (
    <label className={cn("grid min-w-0 content-start gap-1.5", className)}>
      <span className="text-sm leading-none font-medium select-none">{label}</span>
      {children}
    </label>
  );
}
export function Text({
  label,
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

// Radix Select keeps "" for "nothing selected", so an empty option value
// travels as this stand-in.
const EMPTY = "\u0000empty";

/** The app's dropdown, for a field or (with `aria-label`) a table cell. */
export function Dropdown<T extends string>({
  id,
  value,
  onChange,
  options,
  disabled,
  size = "default",
  className,
  "aria-label": ariaLabel,
}: {
  id?: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly (T | readonly [T, string])[];
  disabled?: boolean;
  size?: "sm" | "default";
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Select
      value={value === "" ? EMPTY : value}
      onValueChange={(next) => onChange((next === EMPTY ? "" : next) as T)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        size={size}
        aria-label={ariaLabel}
        className={cn("w-full min-w-0", className)}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => {
          const [key, name] =
            typeof option === "string" ? [option, option] : option;
          return (
            <SelectItem key={key} value={key === "" ? EMPTY : key}>
              {name}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
}
export function Choice<T extends string>({
  label,
  value,
  onChange,
  options,
  disabled,
  className,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly (T | readonly [T, string])[];
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <Field label={label} htmlFor={id} className={className}>
      <Dropdown
        id={id}
        value={value}
        onChange={onChange}
        options={options}
        disabled={disabled}
      />
    </Field>
  );
}
/** A checkbox with its label beside it, as in the connection dialog. */
export function Check({
  label,
  checked,
  onChange,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  label?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const box = (
    <Checkbox
      checked={checked}
      disabled={disabled}
      aria-label={ariaLabel}
      onCheckedChange={(value) => onChange(value === true)}
    />
  );
  if (label === undefined) return box;
  return (
    <label
      className={cn(
        "flex cursor-pointer items-center gap-2 text-sm select-none has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50",
        className,
      )}
    >
      {box}
      {label}
    </label>
  );
}
/** Help, progress and errors as text, the way the connection dialog says them. */
export function Notice({
  children,
  error = false,
  busy = false,
}: {
  children: ReactNode;
  error?: boolean;
  busy?: boolean;
}) {
  const Icon = error ? XCircle : busy ? Loader2 : Info;
  return (
    <p
      role={error ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 text-sm whitespace-pre-wrap select-text",
        error ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", busy && "animate-spin")} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
/** A titled group inside a tool, like the Start screen's sections. */
export function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <h2 className="mr-auto text-sm font-medium">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
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
    <div className="max-h-96 shrink-0 overflow-auto rounded-md border">
      <table className="w-full border-collapse text-[13px]">
        <thead className="sticky top-0 bg-panel">
          <tr>
            {data.columns.map((c, i) => (
              <th
                key={i}
                className={`h-8 border-b px-3 text-xs font-medium whitespace-nowrap text-muted-foreground ${numeric[i]?"text-right":"text-left"}`}
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
                className={cn("border-b last:border-0", onRow && "cursor-pointer outline-none hover:bg-accent/40 focus-visible:bg-accent/60", selected?.(record) && "bg-accent")}
              >
                {row.map((v, i) => (
                  <td
                    key={i}
                    className={cn("h-8 max-w-lg truncate px-3 select-text", numeric[i] && "text-right tabular-nums", v === null && "text-muted-foreground")}
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
        <p className="px-3 py-2 text-sm text-muted-foreground">No rows returned.</p>
      )}
      {data.truncated && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
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
          disabled={busy || !script.trim()}
          onClick={() => void prepare()}
          variant="outline"
        >
          {label}
        </Button>
        <Button
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
          <pre className={cn(codeClass, "min-h-0 flex-1")}>
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
        disabled={busy}
        onClick={() => (write ? void prepare() : void run())}
        variant={write?"default":"outline"}
      >
        {busy ? "Working…" : label}
      </Button>
      {busy && runningToken.current && (
        <Button
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
        <pre className={cn(codeClass, "max-h-72")}>
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
          <pre className={cn(codeClass, "max-h-80")}>
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
