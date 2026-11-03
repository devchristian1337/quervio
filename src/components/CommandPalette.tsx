import { useRef, useState } from "react";
import { Database, FileCode2, FolderOpen, Import, PanelBottom, Plus, Save, Settings, WandSparkles, Wrench } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { useCommandPalette, useConnectDialog, useSettingsDialog, useSsmsImportDialog } from "@/stores/dialogs";
import { useQueries } from "@/stores/queries";
import { useConnections } from "@/stores/connections";
import { TOOL_NAMES, useWorkbench, type ToolKind } from "@/stores/workbench";
import { displayName } from "@/lib/api";
import { keysOf, type CommandId } from "@/lib/commands";
import { runCommand } from "@/lib/shortcuts";
import { focusEditor } from "@/lib/editor";
import { useSettings } from "@/stores/settings";
import type { Context } from "@/lib/management-api";

export function CommandPalette({ context, onPointerDismiss }: { context: Context; onPointerDismiss: () => void }) {
  const { open, setOpen, openedByPointer } = useCommandPalette();
  const [search, setSearch] = useState("");
  const pending = useRef<(() => void) | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const queries = useQueries((s) => s.tabs);
  const activeQueryId = useQueries((s) => s.activeId);
  const workbench = useWorkbench();
  const connections = useConnections((s) => s.connections);
  const shortcuts = useSettings((s) => s.settings.shortcuts);
  const activeQuery = queries.find((tab) => tab.id === activeQueryId);
  const canEdit = !workbench.activeId && Boolean(activeQuery);

  function newQuery(connectionId: string, database: string | null) {
    void useQueries.getState().open(connectionId, database).then(() => requestAnimationFrame(focusEditor));
  }

  function select(action: () => void) {
    // Wait for the palette's focus trap to close before opening another dialog
    // or handing focus to a query.
    pending.current = action;
    setOpen(false);
  }
  function shortcut(id: CommandId) {
    const label = keysOf(id, shortcuts)[0];
    return label ? <CommandShortcut>{label}</CommandShortcut> : null;
  }

  return (
    <CommandDialog
      open={open}
      onOpenAutoFocus={() => { previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
      onOpenChange={(next) => { if (next) setSearch(""); setOpen(next); }}
      onCloseAutoFocus={(event) => {
        setSearch("");
        const action = pending.current;
        pending.current = null;
        event.preventDefault();
        if (action) action();
        else if (openedByPointer) onPointerDismiss();
        else previousFocus.current?.focus();
      }}
    >
      <CommandInput aria-label="Search commands" placeholder="Search commands, tools, tabs or connections…" value={search} onValueChange={setSearch} />
      <CommandList label="Commands">
        <CommandEmpty>No matching commands, tabs or connections.</CommandEmpty>
        <CommandGroup heading="Quick actions">
          <CommandItem value="action-new-query" keywords={["New query", "SQL"]} disabled={!context.connectionId} onSelect={() => select(() => newQuery(context.connectionId, context.database))}>
            <Plus /><span>New query</span>{shortcut("newQuery")}
          </CommandItem>
          <CommandItem value="action-open-file" keywords={["Open file", "SQL script"]} onSelect={() => select(() => runCommand("openFile"))}>
            <FolderOpen /><span>Open file</span>{shortcut("openFile")}
          </CommandItem>
          {canEdit && <>
          <CommandItem value="action-save" keywords={["Save", "file"]} onSelect={() => select(() => runCommand("save"))}>
            <Save /><span>Save query</span>{shortcut("save")}
          </CommandItem>
          <CommandItem value="action-format" keywords={["Format document or selection", "SQL"]} onSelect={() => select(() => runCommand("format"))}>
            <WandSparkles /><span>Format document or selection</span>{shortcut("format")}
          </CommandItem>
          <CommandItem value="action-results" keywords={["Show hide results pane"]} onSelect={() => select(() => runCommand("toggleResults"))}>
            <PanelBottom /><span>Show or hide results</span>{shortcut("toggleResults")}
          </CommandItem>
          </>}
          <CommandItem value="action-new-connection" keywords={["New connection", "server"]} onSelect={() => select(() => useConnectDialog.getState().show())}>
            <Database /><span>New connection</span>
          </CommandItem>
          <CommandItem value="action-import-ssms" keywords={["Import from SSMS", "connections"]} onSelect={() => select(() => useSsmsImportDialog.getState().show())}>
            <Import /><span>Import connections from SSMS</span>
          </CommandItem>
          <CommandItem value="action-settings" keywords={["Open settings", "preferences", "theme", "shortcuts"]} onSelect={() => select(() => useSettingsDialog.getState().show())}>
            <Settings /><span>Open settings</span>{shortcut("settings")}
          </CommandItem>
        </CommandGroup>
        {(queries.length > 0 || workbench.tabs.length > 0) && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Open tabs">
              {queries.map((tab) => {
                const connection = connections.find((c) => c.id === tab.connectionId);
                const detail = [connection ? displayName(connection) : tab.server?.serverName, tab.database].filter(Boolean).join(" · ");
                return (
                  <CommandItem key={tab.id} value={`query-${tab.id}`} keywords={[tab.title, detail]} onSelect={() => select(() => { useQueries.getState().activate(tab.id); useWorkbench.getState().activate(null); requestAnimationFrame(focusEditor); })}>
                    <FileCode2 />
                    <span className="min-w-0 flex-1"><span className="block truncate">{tab.title}{tab.dirty ? "*" : ""}</span><span className="block truncate text-xs text-muted-foreground">{detail}</span></span>
                  </CommandItem>
                );
              })}
              {workbench.tabs.map((tab) => (
                <CommandItem key={tab.id} value={`tab-${tab.id}`} keywords={[TOOL_NAMES[tab.kind], tab.name ?? "", tab.database ?? ""]} onSelect={() => select(() => useWorkbench.getState().activate(tab.id))}>
                  <Wrench /><span className="min-w-0 truncate">{TOOL_NAMES[tab.kind]}{tab.name ? ` · ${tab.name}` : ""}{tab.database ? ` · ${tab.database}` : ""}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
        <CommandSeparator />
        <CommandGroup heading="Tools">
          {(Object.entries(TOOL_NAMES) as [ToolKind, string][]).map(([kind, label]) => (
            <CommandItem key={kind} value={`tool-${kind}`} keywords={[label]} disabled={!context.connectionId && kind !== "templates" && kind !== "components"} onSelect={() => select(() => useWorkbench.getState().open(kind, context))}>
              <Wrench /><span>{label}</span>
            </CommandItem>
          ))}
        </CommandGroup>
        {connections.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="New query on connection">
              {connections.map((connection) => (
                <CommandItem key={connection.id} value={`connection-${connection.id}`} keywords={[displayName(connection), connection.group ?? "", connection.defaultDatabase ?? "", "connection", "new query"]} onSelect={() => select(() => newQuery(connection.id, connection.defaultDatabase))}>
                  <Database /><span className="min-w-0 flex-1"><span className="block truncate">{displayName(connection)}</span><span className="block truncate text-xs text-muted-foreground">{connection.defaultDatabase ?? "Default database"}</span></span>
                </CommandItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
      <div className="flex items-center gap-4 border-t px-4 py-2 text-xs text-muted-foreground" aria-hidden="true">
        <span>↑ ↓ Navigate</span><span>Enter Select</span><span className="ml-auto">Esc Close</span>
      </div>
    </CommandDialog>
  );
}
