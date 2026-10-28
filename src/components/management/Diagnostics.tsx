import { useState, useMemo } from "react";
import {
  management,
  records,
  quoteName as n,
  type Context,
  type Resource,
  type DataTable,
} from "@/lib/management-api";
import { queryStoreAction } from "@/lib/sql-management";
import { errorMessage } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Choice,
  DataGrid,
  Notice,
  Operation,
  Text,
  useRead,
} from "./shared";
import { PlanViewer } from "./PlanViewer";

export function ActivityMonitor({ context }: { context: Context }) {
  const [view, setView] = useState("activity"),
    [interval, setInterval] = useState("5"),
    [session, setSession] = useState("");
  const kind: Resource =
    view === "live"
      ? { kind: "live", sessionId: Number(session) || 0 }
      : {
          kind: view as
            | "activity"
            | "waits"
            | "io"
            | "cpu"
            | "expensiveQueries",
        };
  const data = useRead(
    context,
    view === "live" && !session ? null : kind,
    Number(interval),
  );
  const liveXml = data.data?.columns.includes("query_plan")
    ? data.data.rows[0]?.[0]
    : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label="Activity"
          value={view}
          onChange={setView}
          options={[
            ["activity", "Processes and blocking"],
            ["waits", "Wait statistics (since last reset)"],
            ["io", "File I/O (cumulative)"],
            ["cpu", "SQL process CPU samples"],
            ["expensiveQueries", "Cached query totals"],
            ["live", "Live query statistics"],
          ]}
        />
        <Choice
          label="Refresh"
          value={interval}
          onChange={setInterval}
          options={[
            ["0", "Manual"],
            ["1", "1 second"],
            ["5", "5 seconds"],
            ["15", "15 seconds"],
            ["30", "30 seconds"],
          ]}
        />
        {view === "live" && (
          <Text
            label="SQL session ID"
            value={session}
            onChange={setSession}
            type="number"
          />
        )}
        <Button
          variant="outline"
          onClick={data.refresh}
          disabled={data.loading}
        >
          {data.loading ? "Loading…" : "Refresh"}
        </Button>
        {data.updated && (
          <span className="flex h-9 items-center text-xs text-muted-foreground">
            Updated {data.updated.toLocaleTimeString()}
          </span>
        )}
      </div>
      {data.error && <Notice error>{data.error}</Notice>}
      {liveXml ? (
        <PlanViewer xml={liveXml} />
      ) : (
        data.data && <DataGrid data={data.data} />
      )}
      {view === "live" && (
        <p className="text-xs text-muted-foreground">
          Select an executing SQL session. Profiling must be available for that
          request. Monitoring pauses while this tool or the application is
          hidden.
        </p>
      )}
    </div>
  );
}

export function QueryStore({ context }: { context: Context }) {
  const [minutes, setMinutes] = useState("60"),
    [listing, setListing] = useState("top"),
    [storage, setStorage] = useState("1000"),
    [retention, setRetention] = useState("30"),
    [query, setQuery] = useState(""),
    [plan, setPlan] = useState(""),
    [compare, setCompare] = useState("");
  const options = useRead(context, { kind: "queryStoreOptions" });
  const queries = useRead(context, {
    kind:
      listing === "regressions" ? "queryStoreRegressions" : "queryStoreQueries",
    minutes: Number(minutes),
  });
  const plans = useRead(
    context,
    query ? { kind: "queryStorePlans", queryId: Number(query) } : null,
  );
  const left = useRead(
    context,
    plan ? { kind: "queryStorePlan", planId: Number(plan) } : null,
  );
  const right = useRead(
    context,
    compare ? { kind: "queryStorePlan", planId: Number(compare) } : null,
  );
  const action = query && plan ? queryStoreAction(query, plan, true) : "";
  const history = useRead(
    context,
    query
      ? {
          kind: "queryStoreHistory",
          queryId: Number(query),
          minutes: Number(minutes),
        }
      : null,
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label="Query ranking"
          value={listing}
          onChange={(value) => {
            setListing(value);
            setQuery("");
            setPlan("");
            setCompare("");
          }}
          options={[
            ["top", "Highest average duration"],
            [
              "regressions",
              "Regressions versus previous equal interval (>25%)",
            ],
          ]}
        />
        <Choice
          label="Runtime interval"
          value={minutes}
          onChange={(value) => {
            setMinutes(value);
            setQuery("");
            setPlan("");
            setCompare("");
          }}
          options={[
            ["60", "Last hour"],
            ["1440", "Last 24 hours"],
            ["10080", "Last 7 days"],
            ["43200", "Last 30 days"],
          ]}
        />
        <Button variant="outline" onClick={queries.refresh}>
          Refresh
        </Button>
        <Operation
          context={context}
          script="ALTER DATABASE CURRENT SET QUERY_STORE = ON (OPERATION_MODE = READ_WRITE);"
          label="Enable Query Store"
          onApplied={() => {
            options.refresh();
            queries.refresh();
          }}
        />
        <Operation
          context={context}
          script="ALTER DATABASE CURRENT SET QUERY_STORE (OPERATION_MODE = READ_ONLY);"
          label="Set read-only"
          onApplied={options.refresh}
        />
      </div>
      {options.error && <Notice error>{options.error}</Notice>}
      {options.data && <DataGrid data={options.data} />}
      <div className="flex flex-wrap items-end gap-3">
        <Text
          label="Maximum Query Store size (MB)"
          value={storage}
          onChange={setStorage}
          type="number"
        />
        <Text
          label="Retain history (days)"
          value={retention}
          onChange={setRetention}
          type="number"
        />
        <Operation
          context={context}
          script={
            /^\d+$/.test(storage) &&
            Number(storage) > 0 &&
            /^\d+$/.test(retention) &&
            Number(retention) > 0
              ? `ALTER DATABASE CURRENT SET QUERY_STORE (MAX_STORAGE_SIZE_MB=${storage}, CLEANUP_POLICY=(STALE_QUERY_THRESHOLD_DAYS=${retention}));`
              : ""
          }
          label="Preview Query Store settings"
          onApplied={options.refresh}
        />
      </div>
      {queries.error && <Notice error>{queries.error}</Notice>}
      {queries.data && (
        <DataGrid
          data={queries.data}
          onRow={(row) => {
            setQuery(row.query_id ?? "");
            setPlan("");
            setCompare("");
          }}
          selected={(row) => row.query_id === query}
        />
      )}
      {query && (
        <>
          <h2 className="border-b pb-2 text-sm font-medium">
            Runtime history · selected interval
          </h2>
          {history.error && <Notice error>{history.error}</Notice>}
          {history.data && <DataGrid data={history.data} />}
          <h2 className="border-b pb-2 text-sm font-medium">
            Plans for query {query} · all retained runtime statistics
          </h2>
          {plans.error && <Notice error>{plans.error}</Notice>}
          {plans.data && (
            <>
              <DataGrid
                data={plans.data}
                onRow={(row) => setPlan(row.plan_id ?? "")}
                selected={(row) => row.plan_id === plan}
              />
              <div className="flex flex-wrap items-end gap-3">
                <Operation
                  context={context}
                  script={action}
                  label="Force selected plan"
                  onApplied={plans.refresh}
                />
                <Operation
                  context={context}
                  script={plan ? queryStoreAction(query, plan, false) : ""}
                  label="Remove forcing"
                  onApplied={plans.refresh}
                />
                <Choice
                  label="Compare against"
                  value={compare}
                  onChange={setCompare}
                  options={[
                    ["", "No comparison"],
                    ...records(plans.data)
                      .filter((r) => r.plan_id !== plan)
                      .map((r): [string, string] => [
                        r.plan_id ?? "",
                        `Plan ${r.plan_id} · ${r.avg_duration_us} µs`,
                      ]),
                  ]}
                />
              </div>
            </>
          )}
          {left.error && <Notice error>{left.error}</Notice>}
          {right.error && <Notice error>{right.error}</Notice>}
          {(left.data?.rows[0]?.[0] || right.data?.rows[0]?.[0]) && (
            <div
              className={`grid min-h-96 gap-3 ${compare ? "grid-cols-2" : "grid-cols-1"}`}
            >
              {left.data?.rows[0]?.[0] && (
                <PlanViewer xml={left.data.rows[0][0]} />
              )}
              {right.data?.rows[0]?.[0] && (
                <PlanViewer xml={right.data.rows[0][0]} />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function eventRows(xml: string): DataTable {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const events = [...doc.getElementsByTagName("event")].reverse();
  return {
    columns: [
      "timestamp",
      "event",
      "duration_us",
      "cpu_time",
      "database_name",
      "session_id",
      "sql_text",
      "message",
    ],
    rows: events.slice(0, 1000).map((event) => {
      const values = Object.fromEntries(
        [...event.children].map((e) => [
          e.getAttribute("name"),
          e.querySelector("value")?.textContent ?? null,
        ]),
      );
      return [
        event.getAttribute("timestamp"),
        event.getAttribute("name"),
        ...[
          "duration",
          "cpu_time",
          "database_name",
          "session_id",
          "sql_text",
          "message",
        ].map((key) => values[key] ?? null),
      ];
    }),
    truncated: events.length > 1000,
  };
}

export function ExtendedEvents({
  context,
  azure,
}: {
  context: Context;
  azure: boolean;
}) {
  const [name, setName] = useState("Quervio_Profiler"),
    [duration, setDuration] = useState("100000"),
    [view, setView] = useState("live"),
    [path, setPath] = useState(""),
    [filter, setFilter] = useState(""),
    [error, setError] = useState<string | null>(null);
  const sessions = useRead(context, { kind: "events" });
  const data = useRead(
    context,
    view === "live" && name
      ? { kind: "eventData", name }
      : view === "file" && path
        ? { kind: "xel", path }
        : null,
    view === "live" ? 5 : 0,
  );
  const scope = azure ? "DATABASE" : "SERVER";
  const script = /^\d+$/.test(duration)
    ? `CREATE EVENT SESSION ${n(name)} ON ${scope}\nADD EVENT sqlserver.rpc_completed(ACTION(sqlserver.sql_text,sqlserver.database_name,sqlserver.session_id) WHERE duration>=${duration}),\nADD EVENT sqlserver.sql_batch_completed(ACTION(sqlserver.sql_text,sqlserver.database_name,sqlserver.session_id) WHERE duration>=${duration}),\nADD EVENT sqlserver.error_reported(ACTION(sqlserver.sql_text,sqlserver.database_name,sqlserver.session_id))\nADD TARGET package0.ring_buffer(SET max_memory=4096)\nWITH (MAX_MEMORY=4096 KB,EVENT_RETENTION_MODE=ALLOW_SINGLE_EVENT_LOSS,MAX_DISPATCH_LATENCY=5 SECONDS,STARTUP_STATE=OFF);\nALTER EVENT SESSION ${n(name)} ON ${scope} STATE=START;`
    : "";
  const table = useMemo(() => {
    if (!data.data) return null;
    let table = data.data;
    if (view === "live") {
      try {
        table = eventRows(table.rows[0]?.[0] ?? "<RingBufferTarget/>");
      } catch {
        return null;
      }
    }
    return filter
      ? {
          ...table,
          rows: table.rows.filter((row) =>
            row.some((value) =>
              value?.toLowerCase().includes(filter.toLowerCase()),
            ),
          ),
        }
      : table;
  }, [data.data, view, filter]);
  async function loadFile() {
    setError(null);
    try {
      const result = await management.read(context, { kind: "xel", path });
      if (!result.rows.length)
        setError("No events found at the server-side path.");
      data.refresh();
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap items-end gap-3">
        <Text label="Session name" value={name} onChange={setName} />
        <Text
          label="Minimum duration (µs)"
          value={duration}
          onChange={setDuration}
          type="number"
        />
        <Operation
          context={context}
          script={script}
          label="Create profiler session"
          onApplied={() => {
            sessions.refresh();
            data.refresh();
          }}
        />
      </div>
      <div className="flex flex-wrap gap-2">
        <Operation
          context={context}
          script={`ALTER EVENT SESSION ${n(name)} ON ${scope} STATE=START;`}
          label="Start"
          onApplied={sessions.refresh}
        />
        <Operation
          context={context}
          script={`ALTER EVENT SESSION ${n(name)} ON ${scope} STATE=STOP;`}
          label="Stop"
          onApplied={sessions.refresh}
        />
        <Operation
          context={context}
          script={`DROP EVENT SESSION ${n(name)} ON ${scope};`}
          label="Delete session"
          onApplied={sessions.refresh}
        />
      </div>
      {sessions.error && <Notice error>{sessions.error}</Notice>}
      {sessions.data && (
        <DataGrid
          data={sessions.data}
          onRow={(row) => setName(row.name ?? "")}
        />
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Choice
          label="Events source"
          value={view}
          onChange={setView}
          options={[
            ["live", "Live ring buffer"],
            ["file", "Server-side .xel file"],
          ]}
        />
        {view === "file" && (
          <>
            <Text
              label="Path accessible to SQL Server (.xel or Azure URL)"
              value={path}
              onChange={setPath}
            />
            <Button variant="outline" onClick={() => void loadFile()}>
              Read file
            </Button>
          </>
        )}
        <Text
          label="Filter captured events"
          value={filter}
          onChange={setFilter}
        />
      </div>
      {(data.error || error) && <Notice error>{data.error ?? error}</Notice>}
      {table && <DataGrid data={table} />}
      <p className="text-xs text-muted-foreground">
        The ring buffer is bounded and may discard older events. Duration is
        expressed in microseconds. Existing server sessions are never stopped
        when this view closes.
      </p>
    </div>
  );
}
