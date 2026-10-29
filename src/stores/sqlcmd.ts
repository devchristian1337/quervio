import { create } from "zustand";
interface Pending {
  script: string;
  localCommands: boolean;
  purpose: "execute" | "fileAccess";
  resolve: (confirmed: boolean) => void;
}
export const useSqlcmdConfirmation = create<{
  pending: Pending | null;
  ask: (script: string, localCommands: boolean, purpose?: Pending["purpose"]) => Promise<boolean>;
  answer: (confirmed: boolean) => void;
}>((set, get) => ({
  pending: null,
  ask: (script, localCommands, purpose = "execute") =>
    new Promise((resolve) => {
      get().pending?.resolve(false);
      set({ pending: { script, localCommands, purpose, resolve } });
    }),
  answer: (confirmed) => {
    get().pending?.resolve(confirmed);
    set({ pending: null });
  },
}));
