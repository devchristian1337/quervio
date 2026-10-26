// Mirrors quervio_core::execution::ExecutionEvent.
export type Outcome = "succeeded" | "failed" | "cancelled";

export type ExecutionEvent =
  | { type: "batchStarted"; batch: number; firstLine: number }
  | { type: "message"; text: string; isError: boolean; header: string | null; line: number | null }
  | { type: "rowsAffected"; count: number }
  | { type: "resultSetStarted"; index: number; columns: { name: string }[] }
  | { type: "resultSetRows"; index: number; rows: number }
  | { type: "resultSetFinished"; index: number; rows: number }
  | {
      type: "finished";
      outcome: Outcome;
      elapsedMs: number;
      database: string;
      openTransactions: number;
    };
