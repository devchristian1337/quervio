import { useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  useTemplates,
  validateTemplates,
  type SqlTemplate,
} from "@/stores/templates";
import { useWorkbench } from "@/stores/workbench";
import { insertText } from "@/lib/editor";
import { api, errorMessage } from "@/lib/api";
import { useQueries } from "@/stores/queries";
import type { Context } from "@/lib/management-api";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Check,
  Notice,
  Text,
  textareaClass,
} from "./shared";

export function Templates({ context }: { context: Context }) {
  const { templates, save: store, remove, replace } = useTemplates();
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState<SqlTemplate | null>(null),
    [error, setError] = useState<string | null>(null);
  async function file(importing: boolean) {
    try {
      if (importing) {
        const path = await open({
          multiple: false,
          filters: [{ name: "SQL templates", extensions: ["json"] }],
        });
        if (path)
          replace(validateTemplates(JSON.parse(await api.fileRead(path))));
      } else {
        const path = await save({ defaultPath: "quervio-templates.json" });
        if (path) await api.fileWrite(path, JSON.stringify(templates, null, 2));
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  function patch(value: Partial<SqlTemplate>) {
    setSelected((t) => (t ? { ...t, ...value } : t));
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex items-end gap-3">
        <Text label="Search templates" value={search} onChange={setSearch} />
        <Button
          variant="outline"
          onClick={() =>
            setSelected({
              id: crypto.randomUUID(),
              name: "",
              category: "Personal",
              description: "",
              body: "",
              snippet: true,
            })
          }
        >
          New template
        </Button>
        <Button variant="outline" onClick={() => void file(false)}>
          Export
        </Button>
        <Button variant="outline" onClick={() => void file(true)}>
          Import
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-3">
        <div className="overflow-auto rounded-md border p-1">
          {templates
            .filter((t) =>
              `${t.name} ${t.category} ${t.description}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((t) => (
              <button
                key={t.id}
                className={cn(
                  "block w-full rounded-sm px-3 py-2 text-left text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
                  selected?.id === t.id ? "bg-accent" : "hover:bg-accent/40",
                )}
                onClick={() => setSelected({ ...t })}
              >
                {t.name}
                <span className="block text-xs text-muted-foreground">
                  {t.category} · {t.snippet ? "Snippet" : "Template"}
                </span>
              </button>
            ))}
        </div>
        {selected ? (
          <div className="flex min-h-0 flex-col gap-3 overflow-auto">
            <Text
              label="Name"
              value={selected.name}
              onChange={(name) => patch({ name })}
            />
            <Text
              label="Category"
              value={selected.category}
              onChange={(category) => patch({ category })}
            />
            <Text
              label="Description"
              value={selected.description}
              onChange={(description) => patch({ description })}
            />
            <textarea
              aria-label="SQL template body"
              value={selected.body}
              onChange={(e) => patch({ body: e.target.value })}
              className={cn(textareaClass, "min-h-52 flex-1")}
            />
            <Check
              label="Show in editor completion · Monaco placeholders are supported"
              checked={selected.snippet}
              onChange={(snippet) => patch({ snippet })}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={!selected.name || !selected.body}
                onClick={() => store(selected)}
              >
                Save template
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  insertText(selected.body, selected.snippet);
                  useWorkbench.getState().activate(null);
                }}
              >
                Insert into current query
              </Button>
              <Button
                variant="outline"
                onClick={() =>
                  void useQueries
                    .getState()
                    .open(context.connectionId, context.database, {
                      text: selected.body
                        .replace(/\$\{\d+:([^}]*)\}/g, "$1")
                        .replace(/\$\d+/g, ""),
                      dirty: true,
                    })
                }
              >
                Open as new query
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  remove(selected.id);
                  setSelected(null);
                }}
              >
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <Notice>Select a template to edit or insert it.</Notice>
        )}
      </div>
    </div>
  );
}
