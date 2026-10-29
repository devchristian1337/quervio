import { useEffect, useMemo, useRef, useState } from "react";
import { Combobox, createListCollection } from "@ark-ui/react/combobox";
import { Check, ChevronDown, Loader2, RefreshCw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useScrollFadeRef } from "@/components/ui/scroll-fade";
import { api, errorMessage, type SavedConnection } from "@/lib/api";

type Options = {
  context: object;
  status: "loading" | "ready" | "failed";
  names: string[];
  error?: string;
};

interface Props {
  connection: SavedConnection;
  password: string;
  canLoad: boolean;
  onChange: (database: string) => void;
}

/** Searchable database names, with manual entry when discovery is unavailable. */
export function DatabasePicker({ connection, password, canLoad, onChange }: Props) {
  const [options, setOptions] = useState<Options | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  const pending = useRef<object | null>(null);
  const mounted = useRef(false);
  // The list mounts each time the picker opens.
  const fadeList = useScrollFadeRef<HTMLDivElement>();
  const login = connection.authentication.kind === "sql" ? connection.authentication.userName : "";
  // Identity only: no passwords in cache keys, DOM attributes or persisted state.
  const context = useMemo(() => ({}), [
    connection.id, connection.server, connection.authentication.kind, login,
    connection.encrypt, connection.trustServerCertificate, password, canLoad,
  ]);
  const currentContext = useRef(context);
  currentContext.current = context;
  const current = options?.context === context ? options : null;
  const value = connection.defaultDatabase ?? "master";
  const names = current?.names ?? [];
  const collection = useMemo(() => createListCollection({
    items: names.filter(name => name.toLocaleLowerCase().includes(query.toLocaleLowerCase())),
  }), [names, query]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  async function load(force = false) {
    if (!canLoad || pending.current === context || (!force && current !== null)) return;
    const requested = context;
    pending.current = requested;
    setOptions({ context: requested, status: "loading", names });
    try {
      const databases = await api.connectionDatabases({ ...connection, server: connection.server.trim() }, password || null);
      if (mounted.current && currentContext.current === requested) {
        setOptions({ context: requested, status: "ready", names: [...new Set(databases.map(db => db.name))] });
      }
    } catch (error) {
      if (mounted.current && currentContext.current === requested) {
        setOptions({ context: requested, status: "failed", names, error: errorMessage(error) });
      }
    } finally {
      if (pending.current === requested) pending.current = null;
    }
  }

  return (
    <Combobox.Root
      collection={collection}
      open={expanded}
      ids={{ input: "database" }}
      value={names.includes(value) ? [value] : []}
      inputValue={value}
      allowCustomValue
      selectionBehavior="preserve"
      openOnClick
      closeOnSelect
      positioning={{ placement: "bottom-start", sameWidth: true, gutter: 4 }}
      translations={{ triggerLabel: "Show databases" }}
      onInputValueChange={({ inputValue, reason }) => {
        if (reason === "input-change") {
          setQuery(inputValue);
          onChange(inputValue);
        }
      }}
      onValueChange={({ value: selected }) => {
        // Typing a custom name clears the list's selection, not the input.
        if (selected[0] !== undefined) {
          onChange(selected[0]);
          setQuery("");
        }
      }}
      onOpenChange={({ open, reason }) => {
        setExpanded(open);
        if (!open) return;
        if (reason === "trigger-click" || reason === "input-click") setQuery("");
        void load();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.preventDefault();
          event.stopPropagation();
          setExpanded(false);
        }
      }}
    >
      <Combobox.Control className="relative">
        <Combobox.Input asChild>
          <Input placeholder="master" className="pr-9" aria-label="Default database" />
        </Combobox.Input>
        <Combobox.Trigger className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
          {current?.status === "loading" ? <Loader2 className="size-4 animate-spin" /> : <ChevronDown className="size-4" />}
        </Combobox.Trigger>
      </Combobox.Control>
      <Combobox.Positioner className="z-50">
        <Combobox.Content className="w-full min-w-56 overflow-hidden rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md outline-none">
          {!canLoad && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Enter server and login details to load databases. You can also type a name.</p>}
          {current?.status === "loading" && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">Loading databases…</p>}
          {current?.status === "failed" && <p role="status" className="px-2 py-2 text-xs text-destructive">Could not load databases. You can type a name or retry.<span className="mt-1 line-clamp-3 block break-words text-muted-foreground select-text">{current.error}</span></p>}
          <Combobox.List ref={fadeList} className="max-h-52 overflow-y-auto">
            {collection.items.map(name => (
              <Combobox.Item key={name} item={name} className="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 outline-none data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground">
                <Combobox.ItemText className="truncate" title={name}>{name}</Combobox.ItemText>
                <Combobox.ItemIndicator><Check className="size-4 shrink-0" /></Combobox.ItemIndicator>
              </Combobox.Item>
            ))}
          </Combobox.List>
          {current?.status === "ready" && collection.items.length === 0 && <p role="status" className="px-2 py-2 text-xs text-muted-foreground">No matching databases. You can type a name.</p>}
          {canLoad && current?.status !== "loading" && (
            <button type="button" className="mt-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground" onClick={() => void load(true)}>
              <RefreshCw className="size-3.5" /> {current?.status === "failed" ? "Retry" : "Refresh databases"}
            </button>
          )}
        </Combobox.Content>
      </Combobox.Positioner>
    </Combobox.Root>
  );
}
