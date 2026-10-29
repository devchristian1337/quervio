// How the connections SSMS knows relate to the Saved Connections already in
// Quervio, for the Import from SSMS dialog. An SSMS registered server and a
// Saved Connection pair up one to one: an APP and a TEST server are often the
// same SQL Server and login with another database, so server and login alone
// cannot tell which Saved Connection is which.
import type { Authentication, Environment, SavedConnection, SsmsConnection } from "@/lib/api";

/**
 * What importing does with an SSMS connection: create it, move and rename the
 * Saved Connection that is already its copy, or nothing when that one is
 * already in place.
 */
export type ImportStatus =
  | { kind: "new"; environment: Environment | null }
  | {
      kind: "move";
      existing: SavedConnection;
      group: string | null;
      name: string;
      /** The Environment its name says, when it has another one. */
      environment: Environment | null;
    }
  | { kind: "saved" };

/**
 * The Environment a registered server's name says, as servers are often
 * named "… [TEST SERVER]"; null when it says none.
 */
export function environmentFromName(name: string): Environment | null {
  if (/\b(test|collaudo|qa|staging)\b/i.test(name)) return "test";
  if (/\b(dev|develop|development|sviluppo|svil)\b/i.test(name)) return "development";
  return null;
}

/** The same server and login: SSMS and Quervio describe it alike. */
export function loginKey(server: string, authentication: Authentication) {
  const login = authentication.kind === "sql" ? `sql:${authentication.userName.toLowerCase()}` : authentication.kind;
  return `${server.trim().toLowerCase()}|${login}`;
}

/** The group and name an SSMS connection takes in Quervio, as ssms.rs `to_saved` gives them. */
export function placement(connection: SsmsConnection) {
  return {
    group: connection.groups.join(" / ") || null,
    name: connection.name.toLowerCase() === connection.server.toLowerCase() ? "" : connection.name,
  };
}

const sameDatabase = (a: string | null, b: string | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

type Rule = (connection: SsmsConnection, saved: SavedConnection, target: ReturnType<typeof placement>) => boolean;

// Tried in order, each over every registered server before the next: the
// surest pairs are taken first, so a looser rule never steals one of them.
const RULES: Rule[] = [
  // Its name, as Quervio 0.1.14 imported it ("Group / Name") or as now, and its database.
  (connection, saved, target) =>
    sameDatabase(saved.defaultDatabase, connection.defaultDatabase) &&
    (saved.name === [...connection.groups, connection.name].join(" / ") ||
      (saved.name === target.name && saved.group === target.group)),
  // Its database.
  (connection, saved) => sameDatabase(saved.defaultDatabase, connection.defaultDatabase),
  // Server and login alone, for a connection whose database was changed since.
  () => true,
];

/** The import status of each SSMS connection, by its id. */
export function matchSaved(found: SsmsConnection[], saved: SavedConnection[]): Map<string, ImportStatus> {
  const statuses = new Map<string, ImportStatus>();
  const free = new Set(saved.map((s) => s.id));
  const registered = found.filter((c) => c.source === "registered");
  for (const rule of RULES) {
    for (const connection of registered) {
      if (statuses.has(connection.id)) continue;
      const key = loginKey(connection.server, connection.authentication);
      const target = placement(connection);
      const match = saved.find(
        (s) => free.has(s.id) && loginKey(s.server, s.authentication) === key && rule(connection, s, target),
      );
      if (!match) continue;
      free.delete(match.id);
      const named = environmentFromName(connection.name);
      const environment = named && named !== match.environment ? named : null;
      const placed = match.group === target.group && match.name === target.name && !environment;
      statuses.set(connection.id, placed ? { kind: "saved" } : { kind: "move", existing: match, ...target, environment });
    }
  }
  // A history entry has no name or group to give: it only needs to exist.
  const logins = new Set(saved.map((s) => loginKey(s.server, s.authentication)));
  for (const connection of found) {
    if (statuses.has(connection.id)) continue;
    const known = connection.source === "history" && logins.has(loginKey(connection.server, connection.authentication));
    statuses.set(connection.id, known ? { kind: "saved" } : { kind: "new", environment: environmentFromName(connection.name) });
  }
  return statuses;
}
