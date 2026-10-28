import { describe, expect, it } from "vitest";
import { bytes, databaseStatus, duration, figures, product, serverPressure, type Health } from "./server-health";

// A sample as the Docker test server returned it.
const sample: Health = {
  server_name: "721c965f8e45",
  product_version: "16.0.4305.5",
  edition: "Developer Edition (64-bit)",
  sampled_at: "2026-10-28T23:08:51.4911614",
  cpu_count: "24",
  max_workers_count: "832",
  active_workers: "52",
  started_at: "2026-10-28T20:51:28.830",
  total_physical_memory_kb: "13029376",
  available_physical_memory_kb: "7983432",
  physical_memory_in_use_kb: "4280320",
  volume_bytes: "1081101176832",
  volume_used_percent: "5.9",
  cpu_percent: ".0083",
  batch_requests: "191800",
  memory_grants_pending: "0",
  user_sessions: "12",
  active_requests: "0",
  blocked_requests: "0",
  database_name: "QuervioIntelliSense",
  state_desc: "ONLINE",
  data_bytes: "8388608",
  data_used_bytes: "3866624",
  log_bytes: "8380416",
  log_used_percent: "6.94",
};

describe("figures", () => {
  it("reads a sample", () => {
    const f = figures(sample, null);
    expect(f.memoryPercent).toBeCloseTo(38.7, 1);
    expect(f.workersPercent).toBeCloseTo(6.25, 2);
    expect(f.dataPercent).toBeCloseTo(46.1, 1);
    expect(Math.round(f.uptimeSeconds!)).toBe(8243);
    expect(f.batchesPerSecond).toBeNull();
  });
  it("turns two samples into a rate of batch requests", () => {
    const next = { ...sample, sampled_at: "2026-10-28T23:08:56.4911614", batch_requests: "192050" };
    expect(figures(next, sample).batchesPerSecond).toBe(50);
  });
  it("gives no rate across a restart", () => {
    const next = { ...sample, sampled_at: "2026-10-28T23:09:56", batch_requests: "10" };
    expect(figures(next, sample).batchesPerSecond).toBeNull();
  });
  it("leaves out what Azure SQL Database does not report", () => {
    const azure = { ...sample, total_physical_memory_kb: null, available_physical_memory_kb: null, volume_used_percent: null, started_at: null, max_workers_count: null };
    const f = figures(azure, null);
    expect([f.memoryPercent, f.diskPercent, f.uptimeSeconds, f.workersPercent]).toEqual([null, null, null, null]);
  });
});

describe("pressure and status", () => {
  it("names what is under pressure", () => {
    expect(serverPressure(figures(sample, null))).toEqual([]);
    const busy = figures({ ...sample, cpu_percent: "97", blocked_requests: "2", memory_grants_pending: "1" }, null);
    expect(serverPressure(busy)).toEqual(["CPU at 97%", "1 memory grant pending", "2 blocked requests"]);
  });
  it("reads the database state", () => {
    expect(databaseStatus("ONLINE")).toBe("online");
    expect(databaseStatus("RESTORING")).toBe("provisioning");
    expect(databaseStatus("SUSPECT")).toBe("degraded");
    expect(databaseStatus("OFFLINE")).toBe("offline");
  });
});

describe("formatting", () => {
  it("writes sizes, durations and the product", () => {
    expect(bytes(8388608)).toBe("8 MB");
    expect(bytes(13029376 * 1024)).toBe("12.4 GB");
    expect(bytes(1081101176832)).toBe("1007 GB");
    expect(bytes(null)).toBe("—");
    expect(duration(45)).toBe("45 s");
    expect(duration(8243)).toBe("2 h 17 min");
    expect(duration(3 * 86400 + 7200)).toBe("3 d 2 h");
    expect(product("16.0.4305.5", "Developer Edition (64-bit)")).toBe("SQL Server 2022 · Developer Edition");
    expect(product("12.0.6024.0", null)).toBe("SQL Server 2014");
  });
});
