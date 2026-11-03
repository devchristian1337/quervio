import { useMemo, useState } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { api, errorMessage } from "@/lib/api";
import { Dropdown, Notice } from "./shared";

interface PlanNode {
  id: number;
  operation: string;
  physical: string;
  rows: string;
  actual: string;
  cost: number;
  attributes: [string, string][];
  warnings: string[];
  children: PlanNode[];
  x: number;
  y: number;
}
// The system locale's separators; "—" for a missing or broken attribute.
const rowsFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
const costFormat = new Intl.NumberFormat(undefined, { maximumSignificantDigits: 4 });
const compactFormat = new Intl.NumberFormat(undefined, { notation: "compact", maximumSignificantDigits: 4 });

function formatRows(value: string) {
  // Actual rows are summed as BigInt and can pass 2^53: format them whole.
  // Past a trillion they go compact, or the line runs out of its box.
  if (/^\d+$/.test(value)) {
    const rows = BigInt(value);
    return (rows >= 1_000_000_000_000n ? compactFormat : rowsFormat).format(rows);
  }
  const number = Number(value);
  if (value.trim() === "" || !Number.isFinite(number)) return "—";
  return (Math.abs(number) >= 1e12 ? compactFormat : rowsFormat).format(number);
}

function formatCost(cost: number) {
  if (!Number.isFinite(cost)) return "—";
  // Huge costs read as 1.235M, not 1.235e+6; small ones keep their digits.
  return Math.abs(cost) >= 1e6 ? compactFormat.format(cost) : costFormat.format(cost);
}

/** Cuts `text` to `max` characters, the last one an ellipsis. */
function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function parsePlan(xml: string) {
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  if (
    doc.getElementsByTagName("parsererror").length ||
    doc.documentElement.localName !== "ShowPlanXML"
  )
    throw new Error(
      "This file does not contain valid SQL Server Showplan XML.",
    );
  let row = 0;
  const nodes: PlanNode[] = [];
  function build(element: Element, depth: number): PlanNode {
    const counters = [
      ...element.getElementsByTagNameNS("*", "RunTimeCountersPerThread"),
    ].filter((c) => c.closest("RelOp") === element);
    const actual = counters.length
      ? counters
          .reduce(
            (sum, c) => sum + BigInt(c.getAttribute("ActualRows") ?? "0"),
            0n,
          )
          .toString()
      : "—";
    const node: PlanNode = {
      id: nodes.length,
      operation: element.getAttribute("LogicalOp") ?? "Operator",
      physical: element.getAttribute("PhysicalOp") ?? "",
      rows: element.getAttribute("EstimateRows") ?? "—",
      actual,
      cost: Number(element.getAttribute("EstimatedTotalSubtreeCost") ?? 0),
      attributes: [...element.attributes].map((a) => [a.name, a.value]),
      warnings: [...element.getElementsByTagNameNS("*", "Warnings")]
        .filter((w) => w.closest("RelOp") === element)
        .map(
          (w) =>
            w.textContent?.trim() ||
            [...w.attributes].map((a) => `${a.name}: ${a.value}`).join(", ") ||
            "Operator warning",
        ),
      children: [],
      x: depth * 250,
      y: row++ * 105,
    };
    nodes.push(node);
    const children = [...element.getElementsByTagNameNS("*", "RelOp")].filter(
      (child) => {
        let parent = child.parentElement;
        while (parent && parent !== element && parent.localName !== "RelOp")
          parent = parent.parentElement;
        return parent === element;
      },
    );
    node.children = children.map((child) => build(child, depth + 1));
    return node;
  }
  const roots = [...doc.getElementsByTagNameNS("*", "RelOp")].filter((e) => {
    let p = e.parentElement;
    while (p) {
      if (p.localName === "RelOp") return false;
      p = p.parentElement;
    }
    return true;
  });
  roots.forEach((root) => build(root, 0));
  return {
    nodes,
    width: Math.max(700, ...nodes.map((n) => n.x + 230)),
    height: Math.max(200, row * 105),
  };
}

export function PlanViewer({
  xml: supplied,
  plans,
}: {
  xml?: string;
  plans?: string[];
}) {
  const [loaded, setLoaded] = useState<string | null>(null),
    [index, setIndex] = useState(0),
    [selected, setSelected] = useState<number | null>(null),
    [error, setError] = useState<string | null>(null),
    [zoom, setZoom] = useState(1);
  const xml =
    loaded ??
    supplied ??
    plans?.[Math.min(index, (plans?.length ?? 1) - 1)] ??
    "";
  const parsed = useMemo(() => {
    if (!xml) return null;
    try {
      return parsePlan(xml);
    } catch (error) {
      return errorMessage(error);
    }
  }, [xml]);
  const chosen =
    parsed && typeof parsed !== "string"
      ? parsed.nodes.find((n) => n.id === selected)
      : null;
  async function read() {
    try {
      const path = await open({
        multiple: false,
        filters: [{ name: "Execution plan", extensions: ["sqlplan"] }],
      });
      if (path) {
        setLoaded(await api.fileRead(path));
        setSelected(null);
        setError(null);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  async function write() {
    try {
      const path = await save({
        defaultPath: "plan.sqlplan",
        filters: [{ name: "Execution plan", extensions: ["sqlplan"] }],
      });
      if (path) await api.fileWrite(path, xml);
    } catch (e) {
      setError(errorMessage(e));
    }
  }
  return (
    <section className="flex min-h-52 flex-1 flex-col gap-2 overflow-hidden">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void read()}>
          Open .sqlplan
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!xml}
          onClick={() => void write()}
        >
          Save .sqlplan
        </Button>
        {(plans?.length ?? 0) > 1 && (
          <Dropdown
            aria-label="Statement plan"
            size="sm"
            className="w-32"
            value={String(index)}
            onChange={(value) => {
              setIndex(Number(value));
              setLoaded(null);
              setSelected(null);
            }}
            options={plans!.map((_, i): [string, string] => [String(i), `Plan ${i + 1}`])}
          />
        )}
        <Dropdown
          aria-label="Plan zoom"
          size="sm"
          className="ml-auto w-28"
          value={String(zoom)}
          onChange={(value) => setZoom(Number(value))}
          options={[0.5, 0.75, 1, 1.25, 1.5].map(
            (level): [string, string] => [String(level), `${level * 100}%`],
          )}
        />
      </div>
      {error && <Notice error>{error}</Notice>}
      {typeof parsed === "string" ? (
        <Notice error>{parsed}</Notice>
      ) : parsed ? (
        <div className="flex min-h-0 flex-1 gap-2">
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            <svg
              role="img"
              aria-label="Execution plan operator tree"
              width={parsed.width * zoom}
              height={parsed.height * zoom}
              viewBox={`-8 -8 ${parsed.width} ${parsed.height}`}
            >
              <g>
                {parsed.nodes.flatMap((n) =>
                  n.children.map((c) => (
                    <path
                      key={`${n.id}:${c.id}`}
                      d={`M${n.x + 220},${n.y + 36} H${n.x + 235} V${c.y + 36} H${c.x}`}
                      fill="none"
                      stroke="var(--muted-foreground)"
                      strokeWidth="1.5"
                    />
                  )),
                )}
                {parsed.nodes.map((n) => (
                  <g
                    key={n.id}
                    transform={`translate(${n.x},${n.y})`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${n.physical}, estimated rows ${formatRows(n.rows)}, actual rows ${formatRows(n.actual)}`}
                    onClick={() => setSelected(n.id)}
                    onKeyDown={(e) => e.key === "Enter" && setSelected(n.id)}
                    className="cursor-pointer"
                  >
                    {/* The whole operator name, only where the box cuts it. */}
                    {n.physical.length > 29 && <title>{n.physical}</title>}
                    <rect
                      width="220"
                      height="82"
                      rx="5"
                      fill="var(--panel)"
                      stroke={
                        selected === n.id ? "var(--primary)" : "var(--border)"
                      }
                      strokeWidth={selected === n.id ? 2 : 1}
                    />
                    <text x="10" y="19" fontSize="12" fill="var(--foreground)">
                      {clip(n.physical, 29)}
                    </text>
                    <text
                      x="10"
                      y="37"
                      fontSize="11"
                      fill="var(--muted-foreground)"
                    >
                      Estimated rows: {formatRows(n.rows)}
                    </text>
                    <text
                      x="10"
                      y="54"
                      fontSize="11"
                      fill="var(--muted-foreground)"
                    >
                      Actual rows: {formatRows(n.actual)}
                    </text>
                    <text
                      x="10"
                      y="71"
                      fontSize="11"
                      fill={
                        n.warnings.length
                          ? "var(--destructive)"
                          : "var(--muted-foreground)"
                      }
                    >
                      Subtree cost: {formatCost(n.cost)}
                      {n.warnings.length ? " · Warning" : ""}
                    </text>
                  </g>
                ))}
              </g>
            </svg>
          </div>
          {chosen && (
            <aside className="w-72 shrink-0 overflow-auto rounded-md border p-3 text-xs select-text">
              <h3 className="mb-2 text-sm font-medium">{chosen.operation}</h3>
              {chosen.attributes.map(([name, value]) => (
                <div key={name} className="mb-2 break-words">
                  <span className="text-muted-foreground">{name}: </span>
                  {value}
                </div>
              ))}
              {chosen.warnings.map((w, i) => (
                <Notice key={i} error>
                  {w}
                </Notice>
              ))}
            </aside>
          )}
        </div>
      ) : (
        <Notice>
          Request an estimated or actual plan from the query toolbar, or open a
          .sqlplan file.
        </Notice>
      )}
    </section>
  );
}
