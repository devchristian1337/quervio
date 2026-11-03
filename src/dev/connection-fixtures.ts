// Dev only: Saved Connections that stress the start screen and the Object
// Explorer, behind the switch at the bottom of the page (?mock&data=worst).
// Every value is one a support desk's SSMS really holds; nothing limits the
// length of a name, server, login or group, here or in quervio-core.
import type { SavedConnection } from "@/lib/api";

const base: Omit<SavedConnection, "id" | "name" | "server"> = {
  group: null,
  authentication: { kind: "sql", userName: "sa" },
  defaultDatabase: "H2O_BASE",
  environment: "production",
  encrypt: "mandatory",
  trustServerCertificate: false,
};
const make = (id: string, fields: Partial<SavedConnection> & Pick<SavedConnection, "server">): SavedConnection => ({
  ...base,
  id,
  name: "",
  ...fields,
});

// SSMS nests registered-server groups; the import joins them with " / ".
const NIGUARDA = "Clienti / Lombardia / ASST Grande Ospedale Metropolitano Niguarda / Produzione";
const AZURE = "sqlprd-ambulatorio-01.northwind-industries-holdings.database.windows.net";

const worst: SavedConnection[] = [
  // Long name, long server, long login, long database: all at once.
  make("w-long", {
    group: NIGUARDA,
    name: "Policlinico Universitario Fondazione Agostino Gemelli IRCCS [Ambulatorio – Produzione]",
    server: `${AZURE},1433`,
    authentication: { kind: "sql", userName: "svc_h2o_reporting_readonly_ambulatorio" },
    defaultDatabase: "H2O_AMBULATORIO_PRODUZIONE_2026",
  }),
  // No name: the title is the server, and the two differ only in the database.
  make("w-same-1", { group: NIGUARDA, server: AZURE, defaultDatabase: "H2O_BASE" }),
  make("w-same-2", { group: NIGUARDA, server: AZURE, defaultDatabase: "H2O_BASE_TEST", environment: "test" }),
  // Entra ID login.
  make("w-entra", {
    group: NIGUARDA,
    name: "Azure SQL – Reporting",
    server: "h2o-reporting.database.windows.net",
    authentication: { kind: "entra" },
    defaultDatabase: null,
  }),
  // Two letters, Windows login, no default database.
  make("w-short", {
    group: "Aurelia",
    name: "Jo",
    server: "10.0.1.5",
    authentication: { kind: "windows" },
    defaultDatabase: null,
    environment: "development",
  }),
  // SQL login left empty, named instance and port.
  make("w-instance", {
    group: "Aurelia",
    name: "Đặng Thị Ngọc Hân – Ricoveri",
    server: String.raw`10.0.1.6\SQLEXPRESS2019,14333`,
    authentication: { kind: "sql", userName: "" },
    environment: "test",
  }),
  make("w-rtl", {
    name: "مستشفى الملك فيصل التخصصي",
    server: "kfsh-sql02.example.org",
    authentication: { kind: "sql", userName: "h2o_app" },
    environment: "test",
  }),
  make("w-markup", {
    name: "<b>Sala Operatoria</b> &amp; Rianimazione",
    server: "10.0.2.5",
  }),
  make("w-unbroken", {
    name: "SRV-H2O-CAMILLIANI-APPSERVER-PRODUZIONE-NUOVO-DATACENTER-MILANO-02",
    server: "SRV-H2O-CAMILLIANI-APPSERVER-PRODUZIONE-NUOVO-DATACENTER-MILANO-02",
    environment: "development",
  }),
  make("w-emoji", {
    name: "🔥 PROD Pronto Soccorso",
    server: "10.0.3.7",
    authentication: { kind: "sql", userName: "app" },
  }),
];

const one: SavedConnection[] = [make("one", { name: "Mock server", server: "localhost,14333", defaultDatabase: null })];

/** 1,284 connections in 107 nested groups, as a large support desk's SSMS. */
const huge: SavedConnection[] = Array.from({ length: 1284 }, (_, i) => {
  const client = Math.floor(i / 12);
  const environments = ["production", "test", "development"] as const;
  return make(`h-${i}`, {
    group: `Clienti / Regione ${(client % 20) + 1} / Cliente ${client + 1}`,
    name: `Cliente ${client + 1} [${["APP SERVER", "TEST SERVER", "Ambulatorio", "Ricoveri"][i % 4]} ${i}]`,
    server: `10.${client % 256}.${i % 12}.5`,
    environment: environments[i % 3],
  });
});

export const CONNECTION_FIXTURES = { worst, empty: [] as SavedConnection[], one, huge } as const;
export type FixtureName = "demo" | keyof typeof CONNECTION_FIXTURES;

const SEGMENTS: [FixtureName, string][] = [
  ["demo", "Demo data"],
  ["worst", "Worst case"],
  ["empty", "Empty"],
  ["one", "One"],
  ["huge", "1,284 rows"],
];

export function fixtureFromUrl(): FixtureName {
  const name = new URLSearchParams(location.search).get("data");
  return SEGMENTS.some(([id]) => id === name) ? (name as FixtureName) : "demo";
}

/**
 * The Demo / Worst case switch: plain chrome, fixed at the bottom centre.
 * Only with ?data= in the URL, so it never covers what the UI tests click.
 */
export function mountFixtureSwitch(onChange: (name: FixtureName) => void) {
  if (!new URLSearchParams(location.search).has("data")) return;
  const bar = document.createElement("div");
  bar.setAttribute("role", "radiogroup");
  bar.setAttribute("aria-label", "Mock data");
  bar.style.cssText =
    "position:fixed;left:50%;bottom:12px;transform:translateX(-50%);z-index:2147483647;display:flex;gap:2px;padding:3px;border-radius:9999px;background:#e5e5e5;box-shadow:0 1px 3px rgb(0 0 0/.2);font:500 12px/1 system-ui,sans-serif";
  const paint = (active: FixtureName) => {
    for (const button of bar.children as HTMLCollectionOf<HTMLButtonElement>) {
      const on = button.dataset.fixture === active;
      button.setAttribute("aria-checked", String(on));
      button.style.background = on ? "#fff" : "transparent";
      button.style.color = on ? "#111" : "#555";
      button.style.boxShadow = on ? "0 1px 2px rgb(0 0 0/.15)" : "none";
    }
  };
  for (const [id, label] of SEGMENTS) {
    const button = document.createElement("button");
    button.type = "button";
    button.role = "radio";
    button.dataset.fixture = id;
    button.textContent = label;
    button.style.cssText = "border:0;border-radius:9999px;padding:6px 10px;cursor:pointer;font:inherit";
    button.onclick = () => {
      const url = new URL(location.href);
      url.searchParams.set("data", id);
      history.replaceState(history.state, "", url);
      paint(id);
      onChange(id);
    };
    bar.append(button);
  }
  paint(fixtureFromUrl());
  document.body.append(bar);
}
