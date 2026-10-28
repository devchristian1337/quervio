// The Activity Monitor's cards from one row of the "health" resource
// (crates/quervio-core/src/management.rs): figures as people read them, and
// what puts the server or the database under pressure. Plain data in and
// out, tested in server-health.test.ts.

export type Health = Record<string, string | null>;

const number = (value: string | null | undefined) =>
  value === null || value === undefined || value === "" ? null : Number(value);

/** 8 MB, 1.2 GB, 1 TB: binary units, as Windows and SSMS show sizes. */
export function bytes(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit++;
  }
  const digits = size >= 100 || unit === 0 ? 0 : 1;
  return `${size.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}

/** 45 s, 12 min, 3 h 20 min, 4 d 2 h. */
export function duration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return h ? `${d} d ${h} h` : `${d} d`;
  if (h) return m ? `${h} h ${m} min` : `${h} h`;
  if (m) return `${m} min`;
  return `${Math.floor(seconds)} s`;
}

const RELEASES: Record<string, string> = {
  "9": "2005", "10": "2008", "11": "2012", "12": "2014", "13": "2016",
  "14": "2017", "15": "2019", "16": "2022", "17": "2025",
};

/** "SQL Server 2022 · Developer Edition" from 16.0.4305.5 and "Developer Edition (64-bit)". */
export function product(version: string | null, edition: string | null) {
  const major = version?.split(".")[0] ?? "";
  const name = RELEASES[major] ? `SQL Server ${RELEASES[major]}` : version ? `SQL Server ${version}` : "SQL Server";
  const plain = edition?.replace(/\s*\(64-bit\)\s*$/i, "");
  return plain ? `${name} · ${plain}` : name;
}

const timestamp = (value: string | null) => (value ? Date.parse(value) : NaN);

export interface Figures {
  cpuPercent: number | null;
  memoryPercent: number | null;
  memoryTotal: number | null;
  sqlMemory: number | null;
  diskPercent: number | null;
  diskTotal: number | null;
  workersPercent: number | null;
  uptimeSeconds: number | null;
  batchesPerSecond: number | null;
  sessions: number | null;
  running: number | null;
  blocked: number | null;
  grantsPending: number | null;
  dataPercent: number | null;
  logPercent: number | null;
}

/**
 * The figures of a sample. Batch requests are counted since the server
 * started, so their rate needs the previous sample; without one it is null.
 */
export function figures(row: Health, previous: Health | null): Figures {
  const total = number(row.total_physical_memory_kb);
  const available = number(row.available_physical_memory_kb);
  const workers = number(row.active_workers);
  const maxWorkers = number(row.max_workers_count);
  const data = number(row.data_bytes);
  const dataUsed = number(row.data_used_bytes);
  const sampled = timestamp(row.sampled_at);
  let batchesPerSecond: number | null = null;
  if (previous) {
    const seconds = (sampled - timestamp(previous.sampled_at)) / 1000;
    const count = (number(row.batch_requests) ?? NaN) - (number(previous.batch_requests) ?? NaN);
    // A restart resets the counter: no rate across it.
    if (seconds > 0 && count >= 0) batchesPerSecond = count / seconds;
  }
  return {
    cpuPercent: number(row.cpu_percent),
    memoryPercent: total && available !== null ? ((total - available) / total) * 100 : null,
    memoryTotal: total === null ? null : total * 1024,
    sqlMemory: number(row.physical_memory_in_use_kb) === null ? null : number(row.physical_memory_in_use_kb)! * 1024,
    diskPercent: number(row.volume_used_percent),
    diskTotal: number(row.volume_bytes),
    workersPercent: workers !== null && maxWorkers ? (workers / maxWorkers) * 100 : null,
    uptimeSeconds: row.started_at ? (sampled - timestamp(row.started_at)) / 1000 : null,
    batchesPerSecond,
    sessions: number(row.user_sessions),
    running: number(row.active_requests),
    blocked: number(row.blocked_requests),
    grantsPending: number(row.memory_grants_pending),
    dataPercent: data && dataUsed !== null ? (dataUsed / data) * 100 : null,
    logPercent: number(row.log_used_percent),
  };
}

const CRITICAL = 90;

/** What puts the server under pressure right now, in words; empty when nothing does. */
export function serverPressure(f: Figures): string[] {
  const reasons: string[] = [];
  if ((f.cpuPercent ?? 0) >= CRITICAL) reasons.push(`CPU at ${Math.round(f.cpuPercent!)}%`);
  if ((f.memoryPercent ?? 0) >= CRITICAL) reasons.push(`memory at ${Math.round(f.memoryPercent!)}%`);
  if ((f.diskPercent ?? 0) >= CRITICAL) reasons.push(`disk at ${Math.round(f.diskPercent!)}%`);
  if ((f.workersPercent ?? 0) >= CRITICAL) reasons.push(`worker threads at ${Math.round(f.workersPercent!)}%`);
  if ((f.grantsPending ?? 0) > 0) reasons.push(`${f.grantsPending} memory grant${f.grantsPending === 1 ? "" : "s"} pending`);
  if ((f.blocked ?? 0) > 0) reasons.push(`${f.blocked} blocked request${f.blocked === 1 ? "" : "s"}`);
  return reasons;
}

/**
 * The database's state for its card: ONLINE is online, the passing states
 * are shown as such, SUSPECT and EMERGENCY as trouble, the rest offline.
 * Full files are not trouble: they grow by themselves.
 */
export function databaseStatus(state: string | null): "online" | "degraded" | "offline" | "provisioning" {
  if (state === "ONLINE") return "online";
  if (state === "RESTORING" || state === "RECOVERING" || state === "RECOVERY_PENDING") return "provisioning";
  if (state === "SUSPECT" || state === "EMERGENCY") return "degraded";
  return "offline";
}
