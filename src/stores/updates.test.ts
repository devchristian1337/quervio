import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  settleBeforeExit: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
  Channel: class {
    onmessage = () => {};
  },
}));
vi.mock("@/components/ui/basic-toast", () => ({
  toast: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/exit", () => ({
  settleBeforeExit: mocks.settleBeforeExit,
}));

const { useUpdates } = await import("@/stores/updates");

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  useUpdates.setState({ phase: "idle", available: null, progress: 0, error: null, failed: null });
});

describe("useUpdates concurrency guards", () => {
  it("ignores check() while a download is in progress", async () => {
    const dl = deferred<void>();
    mocks.invoke.mockImplementation((cmd: string) => {
      if (cmd === "update_download") return dl.promise;
      if (cmd === "update_check")
        return Promise.resolve({ installed: true, current: "0.1.38", available: "0.1.39", ready: false, empty: false });
      return Promise.resolve(null);
    });

    const downloading = useUpdates.getState().download();
    expect(useUpdates.getState().phase).toBe("downloading");

    await useUpdates.getState().check();
    expect(useUpdates.getState().phase).toBe("downloading");
    expect(mocks.invoke).not.toHaveBeenCalledWith("update_check");

    dl.resolve();
    await downloading;
    expect(useUpdates.getState().phase).toBe("ready");
  });

  it("prevents concurrent install() calls while settleBeforeExit is awaiting", async () => {
    const settle = deferred<boolean>();
    mocks.settleBeforeExit.mockReturnValueOnce(settle.promise);
    mocks.invoke.mockResolvedValue(null);
    useUpdates.setState({ phase: "ready", available: "0.1.39" });

    const first = useUpdates.getState().install();
    const second = useUpdates.getState().install();
    expect(mocks.settleBeforeExit).toHaveBeenCalledTimes(1);

    settle.resolve(true);
    await Promise.all([first, second]);
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("update_apply");
  });
});
