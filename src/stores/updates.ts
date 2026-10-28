// Updates: checked once at start-up and from Settings › About, downloaded
// and installed on request. Rust side: src-tauri/src/updates.rs.
import { useEffect } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { toast } from "@/components/ui/basic-toast";
import { settleBeforeExit } from "@/lib/exit";

interface UpdateStatus {
  installed: boolean;
  current: string | null;
  available: string | null;
  ready: boolean;
  empty: boolean;
}

export type UpdatePhase =
  | "idle"
  | "checking"
  | "not-installed"
  | "current"
  | "empty"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export const useUpdates = create<{
  phase: UpdatePhase;
  available: string | null;
  progress: number;
  error: string | null;
  /** What failed, when phase is "error". */
  failed: "check" | "download" | "install" | null;
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
}>()((set, get) => ({
  phase: "idle",
  available: null,
  progress: 0,
  error: null,
  failed: null,
  check: async () => {
    set({ phase: "checking", error: null, failed: null });
    try {
      const status = await invoke<UpdateStatus>("update_check");
      set({
        available: status.available,
        phase: !status.installed
          ? "not-installed"
          : status.ready
            ? "ready"
            : status.available
              ? "available"
              : status.empty
                ? "empty"
                : "current",
      });
    } catch (error) {
      set({ phase: "error", error: String(error), failed: "check" });
    }
  },
  download: async () => {
    const onProgress = new Channel<number>();
    onProgress.onmessage = (progress) => set({ progress });
    set({ phase: "downloading", progress: 0, error: null, failed: null });
    try {
      await invoke("update_download", { onProgress });
      set({ phase: "ready" });
    } catch (error) {
      set({ phase: "error", error: String(error), failed: "download" });
    }
  },
  install: async () => {
    if (get().phase !== "ready") return;
    if (!(await settleBeforeExit("restart to update"))) return;
    set({ phase: "installing" });
    try {
      // Quervio exits here; Velopack starts the new version.
      await invoke("update_apply");
    } catch (error) {
      set({ phase: "error", error: String(error), failed: "install" });
    }
  },
}));

/** Looks for an update once, shortly after start-up, and says so if there is one. */
export function useUpdateCheck() {
  useEffect(() => {
    const timer = setTimeout(async () => {
      await useUpdates.getState().check();
      const { phase, available } = useUpdates.getState();
      if (phase === "available" || phase === "ready")
        toast.info(`Quervio ${available} is available`, {
          description: "Install it from Settings › About.",
        });
    }, 5000);
    return () => clearTimeout(timer);
  }, []);
}
