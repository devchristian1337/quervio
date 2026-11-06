import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ ask: vi.fn(), save: vi.fn(), settle: vi.fn(), shutdown: vi.fn() }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ ask: mocks.ask }));
vi.mock("@/lib/session-restore", () => ({ saveNow: mocks.save }));
vi.mock("@/lib/management-api", () => ({ management: { shutdown: mocks.shutdown } }));
vi.mock("@/stores/operations", () => ({ useOperations: { getState: () => ({ running: {} }) } }));
vi.mock("@/stores/queries", () => ({ useQueries: { getState: () => ({ settleAllTransactions: mocks.settle }) } }));
import { settleBeforeExit } from "./exit";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.settle.mockResolvedValue(true);
  mocks.save.mockResolvedValue(false);
});

describe("closing with unavailable query tab recovery", () => {
  it("keeps the app and transactions open when the user chooses to keep working", async () => {
    mocks.ask.mockResolvedValue(false);
    expect(await settleBeforeExit()).toBe(false);
    expect(mocks.ask).toHaveBeenCalledWith(expect.stringContaining("could not be saved"), expect.anything());
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.shutdown).not.toHaveBeenCalled();
  });
  it("continues only after the user accepts closing without the recovery snapshot", async () => {
    mocks.ask.mockResolvedValue(true);
    expect(await settleBeforeExit()).toBe(true);
    expect(mocks.settle).toHaveBeenCalledOnce();
    expect(mocks.shutdown).toHaveBeenCalledOnce();
  });
  it("does not prompt when the snapshot was saved", async () => {
    mocks.save.mockResolvedValue(true);
    expect(await settleBeforeExit()).toBe(true);
    expect(mocks.ask).not.toHaveBeenCalled();
  });
});
