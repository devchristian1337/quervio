// Safety prompts that code awaits like window.confirm, rendered by
// SafetyDialogs.tsx.
import { create } from "zustand";
import type { SavedConnection, ScriptCheck } from "@/lib/api";

export interface DestructiveRequest {
  tabTitle: string;
  connectionName: string;
  check: ScriptCheck;
}

export interface TransactionTab {
  title: string;
  openTransactions: number;
}

export type TransactionChoice = "commit" | "rollback" | "cancel";

export type UnsavedChoice = "save" | "discard" | "cancel";

interface DialogsState {
  destructive: (DestructiveRequest & { resolve: (run: boolean) => void }) | null;
  transactions: { tabs: TransactionTab[]; resolve: (choice: TransactionChoice) => void } | null;
  /** Resolves true when the user chooses to run the script anyway. */
  confirmDestructive: (request: DestructiveRequest) => Promise<boolean>;
  confirmTransactions: (tabs: TransactionTab[]) => Promise<TransactionChoice>;
  unsaved: { title: string; resolve: (choice: UnsavedChoice) => void } | null;
  confirmUnsaved: (title: string) => Promise<UnsavedChoice>;
  deleteConnection: { name: string; resolve: (remove: boolean) => void } | null;
  /** Resolves true when the user confirms deleting the Saved Connection. */
  confirmDeleteConnection: (name: string) => Promise<boolean>;
}

export const useDialogs = create<DialogsState>((set, get) => ({
  destructive: null,
  transactions: null,
  unsaved: null,
  deleteConnection: null,

  confirmDeleteConnection: (name) => {
    if (get().deleteConnection) return Promise.resolve(false);
    return new Promise((resolve) =>
      set({
        deleteConnection: {
          name,
          resolve: (remove) => {
            set({ deleteConnection: null });
            resolve(remove);
          },
        },
      }),
    );
  },

  confirmUnsaved: (title) => {
    if (get().unsaved) return Promise.resolve("cancel");
    return new Promise((resolve) =>
      set({
        unsaved: {
          title,
          resolve: (choice) => {
            set({ unsaved: null });
            resolve(choice);
          },
        },
      }),
    );
  },

  confirmDestructive: (request) => {
    // One prompt at a time: a second F5 while it is open is ignored.
    if (get().destructive) return Promise.resolve(false);
    return new Promise((resolve) =>
      set({
        destructive: {
          ...request,
          resolve: (run) => {
            set({ destructive: null });
            resolve(run);
          },
        },
      }),
    );
  },

  confirmTransactions: (tabs) => {
    if (get().transactions) return Promise.resolve("cancel");
    return new Promise((resolve) =>
      set({
        transactions: {
          tabs,
          resolve: (choice) => {
            set({ transactions: null });
            resolve(choice);
          },
        },
      }),
    );
  },
}));

export type SettingsSection = "appearance" | "editor" | "results" | "query" | "shortcuts" | "about";

/** The Settings dialog, opened from the Object Explorer, Ctrl+, or the About link. */
export const useSettingsDialog = create<{
  open: boolean;
  section: SettingsSection;
  show: (section?: SettingsSection) => void;
  hide: () => void;
}>()((set) => ({
  open: false,
  section: "appearance",
  show: (section) => set((s) => ({ open: true, section: section ?? s.section })),
  hide: () => set({ open: false }),
}));

/** The Connect dialog, opened from the Object Explorer and the start screen. */
export const useConnectDialog = create<{
  open: boolean;
  editing: SavedConnection | null;
  /** What a new connection starts with, such as the group it was created from. */
  preset: Partial<SavedConnection>;
  show: (editing?: SavedConnection | null, preset?: Partial<SavedConnection>) => void;
  setOpen: (open: boolean) => void;
}>()((set) => ({
  open: false,
  editing: null,
  preset: {},
  show: (editing = null, preset = {}) => set({ open: true, editing, preset }),
  setOpen: (open) => set({ open }),
}));

export interface NameRequest {
  title: string;
  description: string;
  value: string;
  confirm: string;
}

/** Asks for a name, such as a new connection group's; null when cancelled. */
export const useNamePrompt = create<{
  request: (NameRequest & { resolve: (name: string | null) => void }) | null;
  ask: (request: NameRequest) => Promise<string | null>;
}>()((set, get) => ({
  request: null,
  ask: (request) => {
    if (get().request) return Promise.resolve(null);
    return new Promise((resolve) =>
      set({
        request: {
          ...request,
          resolve: (name) => {
            set({ request: null });
            resolve(name);
          },
        },
      }),
    );
  },
}));

/** The Import from SSMS dialog, opened from the start screen and the Object Explorer. */
export const useSsmsImportDialog = create<{
  open: boolean;
  show: () => void;
  setOpen: (open: boolean) => void;
}>()((set) => ({
  open: false,
  show: () => set({ open: true }),
  setOpen: (open) => set({ open }),
}));
