import { create } from "zustand";
interface Pending {
  script: string;
  localCommands: boolean;
  resolve: (confirmed: boolean) => void;
}
export const useSqlcmdConfirmation = create<{
  pending: Pending | null;
  ask: (script: string, localCommands: boolean) => Promise<boolean>;
  answer: (confirmed: boolean) => void;
}>((set, get) => ({
  pending: null,
  ask: (script, localCommands) =>
    new Promise((resolve) => {
      get().pending?.resolve(false);
      set({ pending: { script, localCommands, resolve } });
    }),
  answer: (confirmed) => {
    get().pending?.resolve(confirmed);
    set({ pending: null });
  },
}));
