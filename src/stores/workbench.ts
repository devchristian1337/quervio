import { create } from "zustand";
import { useQueries } from "@/stores/queries";
import type { Context } from "@/lib/management-api";

export const TOOL_NAMES = {
  activity: "Activity Monitor",
  queryStore: "Query Store",
  events: "Extended Events / Profiler",
  table: "Table Designer",
  view: "View Designer",
  diagram: "Relationships",
  backup: "Backup / Restore",
  agent: "SQL Server Agent",
  maintenance: "Maintenance",
  transfer: "Import / Export / Scripts",
  security: "Security / Audit",
  encryption: "Encryption",
  encryptedQuery: "Microsoft Query",
  templates: "Templates / Snippets",
  components: "Microsoft Components",
  properties: "Object Properties",
} as const;
export type ToolKind = keyof typeof TOOL_NAMES;
export interface ToolTab extends Context {
  id: string;
  kind: ToolKind;
  objectId?: number;
  schema?: string;
  name?: string;
}
interface Workbench {
  tabs: ToolTab[];
  activeId: string | null;
  open: (
    kind: ToolKind,
    context: Context,
    object?: { objectId?: number; schema?: string; name?: string },
  ) => void;
  activate: (id: string | null) => void;
  close: (id: string) => void;
}
export const useWorkbench = create<Workbench>((set, get) => ({
  tabs: [],
  activeId: null,
  open: (kind, context, object = {}) => {
    const existing = get().tabs.find(
      (t) =>
        t.kind === kind &&
        t.connectionId === context.connectionId &&
        t.database === context.database &&
        t.objectId === object.objectId,
    );
    if (existing) return set({ activeId: existing.id });
    const tab = { ...context, ...object, id: crypto.randomUUID(), kind };
    set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
  },
  activate: (activeId) => set({ activeId }),
  close: (id) =>
    set((s) => ({
      tabs: s.tabs.filter((t) => t.id !== id),
      activeId: s.activeId === id ? null : s.activeId,
    })),
}));
useQueries.subscribe((next, previous) => {
  if (next.activeId !== previous.activeId)
    useWorkbench.getState().activate(null);
});
