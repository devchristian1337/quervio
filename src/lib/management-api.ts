import { invoke, Channel } from "@tauri-apps/api/core";

export interface DataTable {
  columns: string[];
  rows: (string | null)[][];
  truncated: boolean;
}
export interface Feature {
  state: "available" | "unsupported" | "disabled" | "denied";
  reason: string;
}
export interface ServerCapabilities {
  version: string;
  majorVersion: number;
  edition: string;
  engineEdition: number;
  database: string;
  features: Record<string, Feature>;
}
export interface OperationPreview {
  token: string;
  server: string;
  database: string;
  script: string;
  expiresInSeconds: number;
}
export interface Progress {
  phase: string;
  message: string;
  completed: number | null;
}
export interface Dependency {
  name: string;
  path: string | null;
  available: boolean;
  help: string;
}
export type Resource =
  | {
      kind:
        | "properties"
        | "objects"
        | "serverTriggers"
        | "relations"
        | "activity"
        | "health"
        | "waits"
        | "io"
        | "cpu"
        | "expensiveQueries"
        | "queryStoreOptions"
        | "events"
        | "backups"
        | "jobs"
        | "alerts"
        | "operators"
        | "audits"
        | "encryption"
        | "certificates"
        | "columnKeys";
    }
  | {
      kind: "columns" | "parameters" | "definition" | "objectProperties";
      objectId: number;
    }
  | { kind: "queryStoreQueries" | "queryStoreRegressions"; minutes: number }
  | { kind: "queryStoreHistory"; queryId: number; minutes: number }
  | { kind: "queryStorePlans"; queryId: number }
  | { kind: "queryStorePlan"; planId: number }
  | { kind: "eventData"; name: string }
  | { kind: "xel" | "backupHeader" | "backupFiles" | "auditData"; path: string }
  | { kind: "jobSteps" | "jobHistory"; jobId: string }
  | {
      kind:
        | "principals"
        | "roles"
        | "permissions"
        | "auditSpecifications"
        | "effectivePermissions";
      server: boolean;
    }
  | { kind: "live"; sessionId: number };
export interface Context {
  connectionId: string;
  database: string | null;
  active?: boolean;
}

export const management = {
  shutdown:()=>invoke<void>("management_shutdown"),
  cancel: (token: string) => invoke<void>("management_cancel", { token }),
  installLanguage: (progress: (event: Progress) => void) => {
    const onEvent = new Channel<Progress>();
    onEvent.onmessage = progress;
    return invoke<void>("management_install_language", { onEvent });
  },
  bridgePrepare: (
    context: Context,
    action: string,
    args: Record<string, unknown>,
  ) =>
    invoke<{ token: string; server: string; database: string }>(
      "management_bridge_prepare",
      {
        id: context.connectionId,
        database: context.database,
        request: { action, arguments: args, confirmed: false },
      },
    ),
  capabilities: (context: Context) =>
    invoke<ServerCapabilities>("management_capabilities", {
      id: context.connectionId,
      database: context.database,
    }),
  read: (context: Context, resource: Resource) =>
    invoke<DataTable>("management_read", {
      id: context.connectionId,
      database: context.database,
      resource,
    }),
  prepare: (context: Context, script: string) =>
    invoke<OperationPreview>("management_prepare", {
      id: context.connectionId,
      database: context.database,
      script,
    }),
  discard: (token: string) => invoke<void>("management_discard", { token }),
  apply: (token: string, progress: (event: Progress) => void) => {
    const onEvent = new Channel<Progress>();
    onEvent.onmessage = progress;
    return invoke<string[]>("management_apply", {
      token,
      confirmed: true,
      onEvent,
    });
  },
  dependencies: () => invoke<Dependency[]>("management_dependencies"),
  selectComponent: (kind: "bridge" | "language", path: string) =>
    invoke<void>("management_component_select", { kind, path }),
  bridge: <T = unknown>(
    context: Context,
    action: string,
    args: Record<string, unknown>,
    confirmed: boolean,
    progress: (event: Progress) => void,
    previewToken?: string,
  ): Promise<T> => {
    const onEvent = new Channel<Progress>();
    onEvent.onmessage = progress;
    return invoke<T>("management_bridge", {
      id: context.connectionId,
      database: context.database,
      request: { action, arguments: args, confirmed },
      onEvent,
      previewToken: previewToken ?? null,
    });
  },
};

export const quoteName = (value: string) => `[${value.split("]").join("]]")}]`;
export const sqlLiteral = (value: string) =>
  `N'${value.split("'").join("''")}'`;
export const qualifiedName = (schema: string, name: string) =>
  `${quoteName(schema)}.${quoteName(name)}`;
export function records(table: DataTable): Record<string, string | null>[] {
  return table.rows.map((row) =>
    Object.fromEntries(table.columns.map((name, index) => [name, row[index]])),
  );
}
