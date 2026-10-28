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
import { Notice, Text } from "./shared";

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
          size="sm"
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
        <Button size="sm" variant="outline" onClick={() => void file(false)}>
          Export
        </Button>
        <Button size="sm" variant="outline" onClick={() => void file(true)}>
          Import
        </Button>
      </div>
      {error && <Notice error>{error}</Notice>}
      <div className="grid min-h-0 flex-1 grid-cols-[240px_1fr] gap-3">
        <div className="overflow-auto rounded border">
          {templates
            .filter((t) =>
              `${t.name} ${t.category} ${t.description}`
                .toLowerCase()
                .includes(search.toLowerCase()),
            )
            .map((t) => (
              <button
                key={t.id}
                className={`block w-full border-b p-3 text-left text-sm ${selected?.id === t.id ? "bg-accent" : "hover:bg-accent/40"}`}
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
              className="min-h-52 flex-1 rounded border bg-background p-3 font-mono text-xs"
            />
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={selected.snippet}
                onChange={(e) => patch({ snippet: e.target.checked })}
              />
              Show in editor completion · Monaco placeholders are supported
            </label>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                disabled={!selected.name || !selected.body}
                onClick={() => store(selected)}
              >
                Save template
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  insertText(selected.body, selected.snippet);
                  useWorkbench.getState().activate(null);
                }}
              >
                Insert into current query
              </Button>
              <Button
                size="sm"
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
                size="sm"
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
