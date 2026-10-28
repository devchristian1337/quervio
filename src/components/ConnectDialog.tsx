import { useEffect, useState } from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/radix-checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DatabasePicker } from "@/components/DatabasePicker";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/interfaces-select";
import { api, errorMessage, type Encrypt, type Environment, type SavedConnection } from "@/lib/api";
import { ENVIRONMENTS } from "@/lib/environment";
import { newConnection, transportWarning, useConnections } from "@/stores/connections";

type TestState =
  | { status: "idle" }
  | { status: "running" }
  | { status: "ok"; text: string }
  | { status: "failed"; text: string };

interface Props {
  /** The connection to edit, or null for a new one. */
  editing: SavedConnection | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (connection: SavedConnection) => void;
}

export function ConnectDialog({ editing, open, onOpenChange, onSaved }: Props) {
  const save = useConnections((s) => s.save);
  const [draft, setDraft] = useState<SavedConnection>(newConnection);
  const [password, setPassword] = useState("");
  const [test, setTest] = useState<TestState>({ status: "idle" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(editing ?? newConnection());
    setPassword("");
    setTest({ status: "idle" });
    setError(null);
  }, [open, editing]);

  const update = (patch: Partial<SavedConnection>) => setDraft((d) => ({ ...d, ...patch }));
  const isSql = draft.authentication.kind === "sql";
  const userName = draft.authentication.kind === "sql" ? draft.authentication.userName : "";
  // Editing a SQL login keeps the stored password unless a new one is typed.
  const keepsPassword = editing !== null && editing.authentication.kind === "sql";
  // What still blocks Test and Save, said under the buttons it disables.
  const missing =
    draft.server.trim() === ""
      ? "Enter a server name to test or save."
      : isSql && userName.trim() === ""
        ? "Enter a login to test or save."
        : isSql && password === "" && !keepsPassword
          ? "Enter the password to test or save."
          : null;
  const canSubmit = missing === null;
  const warning = transportWarning(draft);

  const cleaned = (): SavedConnection => ({
    ...draft,
    server: draft.server.trim(),
    name: draft.name.trim(),
    defaultDatabase: draft.defaultDatabase?.trim() || null,
  });

  async function runTest() {
    setTest({ status: "running" });
    try {
      const info = await api.testConnection(cleaned(), password || null);
      setTest({ status: "ok", text: `Connected to ${info.serverName} (SQL Server ${info.version})` });
    } catch (e) {
      setTest({ status: "failed", text: errorMessage(e) });
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setSaving(true);
    setError(null);
    try {
      const saved = await save(cleaned(), password || null);
      onSaved(saved);
      onOpenChange(false);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" onEscapeKeyDown={(event) => {
        // Escape closes the database suggestions before the connection dialog.
        if (document.getElementById("database")?.getAttribute("aria-expanded") === "true") event.preventDefault();
      }}>
        <form onSubmit={submit} autoComplete="off" className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit connection" : "New connection"}</DialogTitle>
            <DialogDescription>
              Passwords are encrypted for your Windows user and never stored in plain text.
            </DialogDescription>
          </DialogHeader>

          <Field label="Server name" htmlFor="server">
            <Input
              id="server"
              autoFocus
              placeholder={String.raw`host, host\instance or host,port`}
              value={draft.server}
              onChange={(e) => update({ server: e.target.value })}
            />
          </Field>

          <Field label="Authentication">
            <Select
              value={draft.authentication.kind}
              onValueChange={(kind) =>
                update({
                  authentication: kind === "sql" ? { kind: "sql", userName } : kind === "entra" ? {kind: "entra"} : { kind: "windows" },
                })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sql">SQL Server Authentication</SelectItem>
                <SelectItem value="windows">Windows Authentication</SelectItem>
                <SelectItem value="entra">Microsoft Entra (interactive)</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {isSql && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Login" htmlFor="login">
                <Input
                  id="login"
                  value={userName}
                  onChange={(e) => update({ authentication: { kind: "sql", userName: e.target.value } })}
                />
              </Field>
              <Field label="Password" htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  placeholder={keepsPassword ? "Unchanged" : ""}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <Field label="Display name" htmlFor="name">
              <Input
                id="name"
                placeholder={draft.server || "Optional"}
                value={draft.name}
                onChange={(e) => update({ name: e.target.value })}
              />
            </Field>
            <Field label="Default database" htmlFor="database">
              <DatabasePicker
                key={`${open}:${editing?.id ?? "new"}`}
                connection={draft}
                password={password}
                canLoad={open && canSubmit}
                onChange={(defaultDatabase) => update({ defaultDatabase })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Environment">
              <Select
                value={draft.environment}
                onValueChange={(environment) => update({ environment: environment as Environment })}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(ENVIRONMENTS) as Environment[]).map((env) => (
                    <SelectItem key={env} value={env}>
                      <span className={`size-2 rounded-full ${ENVIRONMENTS[env].dot}`} />
                      {ENVIRONMENTS[env].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Encrypt">
              <Select value={draft.encrypt} onValueChange={(encrypt) => update({ encrypt: encrypt as Encrypt })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="mandatory">Mandatory</SelectItem>
                  <SelectItem value="optional">Optional</SelectItem>
                  <SelectItem value="strict">Strict (TDS 8.0)</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </div>

          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox
              checked={draft.trustServerCertificate}
              onCheckedChange={(checked) => update({ trustServerCertificate: checked === true })}
            />
            Trust server certificate
          </label>
          {warning && <p className="-mt-2 text-xs text-amber-500">{warning}</p>}

          {test.status !== "idle" && <TestResult state={test} />}
          {error && <p className="text-sm text-destructive select-text">{error}</p>}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              className="mr-auto"
              disabled={!canSubmit || test.status === "running"}
              aria-describedby={missing ? "connect-missing" : undefined}
              onClick={runTest}
            >
              Test connection
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={!canSubmit || saving}
              aria-describedby={missing ? "connect-missing" : undefined}
            >
              {saving && <Loader2 className="animate-spin" />}
              {editing ? "Save" : "Save and connect"}
            </Button>
          </DialogFooter>
          {missing && (
            <p id="connect-missing" className="-mt-2 text-xs text-muted-foreground">
              {missing}
            </p>
          )}
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function TestResult({ state }: { state: TestState }) {
  if (state.status === "running") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Connecting…
      </p>
    );
  }
  if (state.status === "ok") {
    return (
      <p className="flex items-center gap-2 text-sm text-foreground select-text">
        <CheckCircle2 className="size-4 shrink-0" /> {state.text}
      </p>
    );
  }
  if (state.status === "failed") {
    return (
      <p className="flex items-start gap-2 text-sm text-destructive select-text">
        <XCircle className="mt-0.5 size-4 shrink-0" /> {state.text}
      </p>
    );
  }
  return null;
}
