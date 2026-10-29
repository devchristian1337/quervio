// Imports the connections SSMS knows (crates/quervio-core/src/ssms.rs): its
// Registered Servers by group, and the servers in its Connect dialog's
// history, or the registered servers of an exported .regsrvr file. The
// passwords SSMS saved for this Windows user come along in Rust; none
// reaches this page.
import { useEffect, useMemo, useState } from "react";
import { FileUp, KeyRound, Loader2 } from "lucide-react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "@/components/ui/basic-toast";
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/interfaces-select";
import { ScrollFade } from "@/components/ui/scroll-fade";
import { api, errorMessage, type Authentication, type Environment, type SavedConnection, type SsmsConnection } from "@/lib/api";
import { ENVIRONMENTS } from "@/lib/environment";
import { cn } from "@/lib/utils";
import { useConnections } from "@/stores/connections";
import { useSsmsImportDialog } from "@/stores/dialogs";

/** The same server and login: SSMS and Quervio describe it alike. */
function loginKey(server: string, authentication: Authentication) {
  const login = authentication.kind === "sql" ? `sql:${authentication.userName.toLowerCase()}` : authentication.kind;
  return `${server.trim().toLowerCase()}|${login}`;
}

function loginLabel(authentication: Authentication) {
  return authentication.kind === "sql" ? authentication.userName || "SQL login" : authentication.kind === "windows" ? "Windows" : "Entra ID";
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

/**
 * What importing does with an SSMS connection: create it, move the Saved
 * Connection Quervio already has for it into its SSMS group (and name), or
 * nothing, when that one is already in place.
 */
type Status = { kind: "new" } | { kind: "move"; existing: SavedConnection; group: string | null } | { kind: "saved" };

function statusOf(connection: SsmsConnection, saved: Map<string, SavedConnection>): Status {
  const existing = saved.get(loginKey(connection.server, connection.authentication));
  if (!existing) return { kind: "new" };
  const group = connection.groups.join(" / ") || null;
  const name = connection.name.toLowerCase() === connection.server.toLowerCase() ? "" : connection.name;
  const placed = existing.group === group && existing.name === name;
  return connection.source === "registered" && !placed ? { kind: "move", existing, group } : { kind: "saved" };
}

interface Section {
  label: string;
  items: SsmsConnection[];
}

/** Registered servers by group, then the history. */
function sectionsOf(found: SsmsConnection[]): Section[] {
  const sections = new Map<string, Section>();
  for (const connection of found) {
    const label =
      connection.source === "history"
        ? "Recent connections"
        : connection.groups.length > 0
          ? connection.groups.join(" / ")
          : "Registered servers";
    const section = sections.get(label) ?? { label, items: [] };
    section.items.push(connection);
    sections.set(label, section);
  }
  return [...sections.values()];
}

export function SsmsImportDialog() {
  const { open, setOpen } = useSsmsImportDialog();
  const connections = useConnections((s) => s.connections);
  const reload = useConnections((s) => s.load);
  const [file, setFile] = useState<string | null>(null);
  const [found, setFound] = useState<SsmsConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [environment, setEnvironment] = useState<Environment>("production");
  const [importing, setImporting] = useState(false);

  const saved = useMemo(() => new Map(connections.map((c) => [loginKey(c.server, c.authentication), c])), [connections]);
  const isSaved = (connection: SsmsConnection) => statusOf(connection, saved).kind === "saved";

  async function read(path: string | null) {
    setFile(path);
    setFound(null);
    setError(null);
    try {
      const list = await api.ssmsConnections(path);
      setFound(list);
      // Everything not in Quervio yet, as a first import usually wants.
      setPicked(new Set(list.filter((c) => statusOf(c, saved).kind !== "saved").map((c) => c.id)));
    } catch (failure) {
      setFound([]);
      setError(errorMessage(failure));
    }
  }

  useEffect(() => {
    if (!open) return;
    setEnvironment("production");
    void read(null);
    // Read once per opening; the saved connections only preselect.
  }, [open]);

  async function chooseFile() {
    const path = await openDialog({
      multiple: false,
      filters: [{ name: "SSMS registered servers", extensions: ["regsrvr", "xml"] }],
    });
    if (typeof path === "string") await read(path);
  }

  function toggle(ids: string[], on: boolean) {
    setPicked((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  async function importPicked() {
    const picks = (found ?? [])
      .filter((c) => picked.has(c.id))
      .map((c) => {
        const status = statusOf(c, saved);
        return { id: c.id, environment, existing: status.kind === "move" ? status.existing.id : null };
      });
    setImporting(true);
    try {
      await api.ssmsImport(file, picks);
      await reload();
      const moved = picks.filter((pick) => pick.existing).length;
      const created = picks.length - moved;
      const plural = (n: number) => `${n} ${n === 1 ? "connection" : "connections"}`;
      toast.success(
        [created > 0 && `Imported ${plural(created)} from SSMS`, moved > 0 && `${created > 0 ? "moved" : "Moved"} ${plural(moved)} into their groups`]
          .filter(Boolean)
          .join(", "),
      );
      setOpen(false);
    } catch (failure) {
      toast.error("Import failed", { description: errorMessage(failure) });
    } finally {
      setImporting(false);
    }
  }

  const sections = sectionsOf(found ?? []);
  const count = (found ?? []).filter((c) => picked.has(c.id)).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import from SSMS</DialogTitle>
          <DialogDescription>
            {file
              ? `Registered servers in ${file.split(/[\\/]/).pop()}.`
              : "The Registered Servers and recent connections of SQL Server Management Studio on this PC. Saved passwords come along, still encrypted for your Windows user."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3">
          <Button variant="outline" size="sm" onClick={() => void chooseFile()}>
            <FileUp /> From a .regsrvr file…
          </Button>
          {file && (
            <Button variant="ghost" size="sm" onClick={() => void read(null)}>
              Back to this PC's SSMS
            </Button>
          )}
        </div>

        {found === null ? (
          <div className="flex items-center gap-2 py-8 text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Reading SSMS settings…
          </div>
        ) : error ? (
          <p className="py-4 text-sm text-destructive select-text">{error}</p>
        ) : found.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {file
              ? "This file has no Database Engine servers."
              : "SSMS has no saved connections on this PC. Export the Registered Servers from SSMS on another PC (Registered Servers › Tasks › Export) and choose the file."}
          </p>
        ) : (
          <ScrollFade className="scrollbar-inset -mx-6 min-h-0 flex-1 px-6">
            {sections.map((section) => {
              const ids = section.items.filter((c) => !isSaved(c)).map((c) => c.id);
              const all = ids.length > 0 && ids.every((id) => picked.has(id));
              return (
                <div key={section.label} role="group" aria-label={section.label} className="mb-4">
                  <label className="flex items-center gap-3 border-b py-2 text-xs font-medium text-muted-foreground">
                    <Checkbox checked={all} disabled={ids.length === 0} onCheckedChange={(checked) => toggle(ids, checked === true)} />
                    {section.label}
                  </label>
                  {section.items.map((connection) => (
                    <Row
                      key={connection.id}
                      connection={connection}
                      status={statusOf(connection, saved)}
                      picked={picked.has(connection.id)}
                      onPick={(on) => toggle([connection.id], on)}
                    />
                  ))}
                </div>
              );
            })}
          </ScrollFade>
        )}

        <DialogFooter className="items-center sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Environment</span>
            <Select value={environment} onValueChange={(value) => setEnvironment(value as Environment)}>
              <SelectTrigger size="sm" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ENVIRONMENTS) as Environment[]).map((id) => (
                  <SelectItem key={id} value={id}>
                    <span className={cn("size-2 rounded-full", ENVIRONMENTS[id].dot)} />
                    {ENVIRONMENTS[id].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={count === 0 || importing} onClick={() => void importPicked()}>
              {importing && <Loader2 className="animate-spin" />}
              Import {count > 0 ? count : ""}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  connection,
  status,
  picked,
  onPick,
}: {
  connection: SsmsConnection;
  status: Status;
  picked: boolean;
  onPick: (on: boolean) => void;
}) {
  const saved = status.kind === "saved";
  const details = [
    connection.name && connection.server,
    loginLabel(connection.authentication),
    connection.defaultDatabase,
    connection.source === "history" && connection.lastUsed !== null && `SSMS ${connection.ssmsVersion}, ${dateFormat.format(connection.lastUsed)}`,
  ].filter(Boolean);
  return (
    <label className={cn("flex items-center gap-3 border-b py-2 last:border-b-0", saved ? "opacity-60" : "cursor-pointer")}>
      <Checkbox checked={picked && !saved} disabled={saved} onCheckedChange={(checked) => onPick(checked === true)} />
      <div className="min-w-0 flex-1">
        <div className="truncate">{connection.name || connection.server}</div>
        <div className="truncate text-xs text-muted-foreground">{details.join(" · ")}</div>
      </div>
      {saved ? (
        <span className="shrink-0 text-xs text-muted-foreground">Already in Quervio</span>
      ) : status.kind === "move" ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          In Quervio · {status.group ? `moves to ${status.group}` : "takes this name"}
        </span>
      ) : (
        connection.hasPassword && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
            <KeyRound className="size-3.5" /> Password
          </span>
        )
      )}
    </label>
  );
}
