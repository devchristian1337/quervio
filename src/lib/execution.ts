// Mirrors quervio_core::execution::ExecutionEvent.

/** Mirrors quervio_core::results::ColumnKind: how a column sorts and aligns. */
export type ColumnKind = "number" | "date" | "binary" | "text";
export type Outcome = "succeeded" | "failed" | "cancelled";

export type ExecutionEvent =
  | { type: "batchStarted"; batch: number; firstLine: number }
  | { type: "message"; text: string; isError: boolean; header: string | null; line: number | null }
  | { type: "rowsAffected"; count: number }
  | { type: "resultSetStarted"; index: number; columns: { name: string; kind: ColumnKind }[] }
  | { type: "resultSetRows"; index: number; rows: number }
  | { type: "resultSetFinished"; index: number; rows: number }
  | {
      type: "finished";
      outcome: Outcome;
      elapsedMs: number;
      database: string;
      openTransactions: number;
    };
