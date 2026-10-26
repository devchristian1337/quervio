// Safety prompts that code awaits like window.confirm, rendered by
// SafetyDialogs.tsx.
import { create } from "zustand";
import type { ScriptCheck } from "@/lib/api";

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

interface DialogsState {
  destructive: (DestructiveRequest & { resolve: (run: boolean) => void }) | null;
  transactions: { tabs: TransactionTab[]; resolve: (choice: TransactionChoice) => void } | null;
  /** Resolves true when the user chooses to run the script anyway. */
  confirmDestructive: (request: DestructiveRequest) => Promise<boolean>;
  confirmTransactions: (tabs: TransactionTab[]) => Promise<TransactionChoice>;
}

export const useDialogs = create<DialogsState>((set, get) => ({
  destructive: null,
  transactions: null,

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
