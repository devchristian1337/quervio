import { useState } from "react";
import {
  quoteName as n,
  qualifiedName as q,
  sqlLiteral as l,
  type Context,
  type DataTable,
} from "@/lib/management-api";
import { cn } from "@/lib/utils";
import {
  BridgeOperation,
  Check,
  Choice,
  DataGrid,
  Notice,
  Operation,
  ReadTable,
  Text,
  textareaClass,
} from "./shared";

export function Security({ context }: { context: Context }) {
  const [section, setSection] = useState("principals"),
    [scope, setScope] = useState("database"),
    [operation, setOperation] = useState("create"),
    [name, setName] = useState(""),
    [login, setLogin] = useState(""),
    [password, setPassword] = useState(""),
    [windows, setWindows] = useState(false),
    [role, setRole] = useState(""),
    [member, setMember] = useState("");
  const [permission, setPermission] = useState("SELECT"),
    [state, setState] = useState("GRANT"),
    [schema, setSchema] = useState("dbo"),
    [object, setObject] = useState(""),
    [securable, setSecurable] = useState("database"),
    [path, setPath] = useState(""),
    [audit, setAudit] = useState(""),
    [auditAction, setAuditAction] = useState("DATABASE_OBJECT_ACCESS_GROUP");
  const server = scope === "server";
  let script = "";
  if (section === "principals" && name) {
    if (operation === "delete")
      script = `DROP ${server ? "LOGIN" : "USER"} ${n(name)};`;
    else if (server)
      script =
        operation === "disable" || operation === "enable"
          ? `ALTER LOGIN ${n(name)} ${operation === "disable" ? "DISABLE" : "ENABLE"};`
          : operation === "password"
            ? `ALTER LOGIN ${n(name)} WITH PASSWORD=${l(password)};`
            : `CREATE LOGIN ${n(name)} ${windows ? "FROM WINDOWS" : `WITH PASSWORD=${l(password)},CHECK_POLICY=ON`};`;
    else
      script =
        operation === "update"
          ? `ALTER USER ${n(name)} WITH ${login ? `LOGIN=${n(login)},` : ""}DEFAULT_SCHEMA=${n(schema)};`
          : `CREATE USER ${n(name)} ${login ? `FOR LOGIN ${n(login)}` : "WITHOUT LOGIN"} WITH DEFAULT_SCHEMA=${n(schema)};`;
  }
  if (section === "roles" && role)
    script =
      operation === "create"
        ? `CREATE ${server ? "SERVER " : ""}ROLE ${n(role)};`
        : operation === "delete"
          ? `DROP ${server ? "SERVER " : ""}ROLE ${n(role)};`
          : member
            ? `ALTER ${server ? "SERVER " : ""}ROLE ${n(role)} ${operation === "add" ? "ADD" : "DROP"} MEMBER ${n(member)};`
            : "";
  if (section === "permissions" && name && (server || securable !== "object" || object)) {
    const target = server
      ? ""
      : securable === "object"
        ? ` ON OBJECT::${q(schema, object)}`
        : securable === "schema"
          ? ` ON SCHEMA::${n(schema)}`
          : ` ON DATABASE::${n(context.database ?? "master")}`;
    script = `${state} ${permission}${target} ${state === "REVOKE" ? "FROM" : "TO"} ${n(name)};`;
  }
  if (section === "audits" && name)
    script =
      operation === "create" && path
        ? `CREATE SERVER AUDIT ${n(name)} TO FILE(FILEPATH=${l(path)}) WITH(QUEUE_DELAY=1000,ON_FAILURE=CONTINUE);\nALTER SERVER AUDIT ${n(name)} WITH(STATE=ON);`
        : operation === "delete"
          ? `ALTER SERVER AUDIT ${n(name)} WITH(STATE=OFF);\nDROP SERVER AUDIT ${n(name)};`
          : `ALTER SERVER AUDIT ${n(name)} WITH(STATE=${operation === "disable" ? "OFF" : "ON"});`;
  if (section === "auditSpecifications" && name)
    script =
      operation === "create" && audit
        ? `CREATE ${server ? "SERVER" : "DATABASE"} AUDIT SPECIFICATION ${n(name)} FOR SERVER AUDIT ${n(audit)} ADD(${auditAction}) WITH(STATE=ON);`
        : operation === "delete"
          ? `ALTER ${server ? "SERVER" : "DATABASE"} AUDIT SPECIFICATION ${n(name)} WITH(STATE=OFF);\nDROP ${server ? "SERVER" : "DATABASE"} AUDIT SPECIFICATION ${n(name)};`
          : `ALTER ${server ? "SERVER" : "DATABASE"} AUDIT SPECIFICATION ${n(name)} WITH(STATE=${operation === "disable" ? "OFF" : "ON"});`;
  const operations =
    section === "roles"
      ? ["create", "add", "remove", "delete"]
      : section === "principals"
        ? server
          ? ["create", "enable", "disable", "password", "delete"]
          : ["create", "update", "delete"]
        : ["create", "enable", "disable", "delete"];
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <div className="flex flex-wrap gap-3">
        <Choice
          label="Security objects"
          value={section}
          onChange={(v) => {
            setSection(v);
            setOperation("create");
          }}
          options={[
            ["principals", "Logins / users"],
            ["roles", "Roles and membership"],
            ["permissions", "Granular permissions"],
            ["audits", "SQL Server Audit"],
            ["auditSpecifications", "Audit specifications"],
            ["auditData", "Read audit events"],
          ]}
        />
        <Choice
          label="Scope"
          value={scope}
          onChange={(v) => {
            setScope(v);
            setPermission(v === "server" ? "CONNECT SQL" : "SELECT");
            setAuditAction(
              v === "server"
                ? "FAILED_LOGIN_GROUP"
                : "DATABASE_OBJECT_ACCESS_GROUP",
            );
            setOperation("create");
          }}
          options={[
            ["database", "Current database"],
            ["server", "Server"],
          ]}
        />
      </div>
      {section === "auditData" ? (
        <>
          <Text
            label="Server-side .sqlaudit path or URL"
            value={path}
            onChange={setPath}
          />
          {path && (
            <ReadTable
              context={context}
              resource={{ kind: "auditData", path }}
            />
          )}
        </>
      ) : (
        <ReadTable
          context={context}
          resource={
            section === "audits"
              ? { kind: "audits" }
              : {
                  kind: section as
                    | "principals"
                    | "roles"
                    | "permissions"
                    | "auditSpecifications",
                  server,
                }
          }
          onRow={(row) => {
            setName(row.name ?? row.principal_name ?? "");
            setRole(row.role_name ?? "");
            setMember(row.member_name ?? "");
          }}
        />
      )}
      {section !== "auditData" && (
        <>
          <div className="grid grid-cols-3 gap-3">
            {section !== "permissions" && (
              <Choice
                label="Operation"
                value={operation}
                onChange={setOperation}
                options={operations}
              />
            )}
            {section === "roles" ? (
              <>
                <Text label="Role" value={role} onChange={setRole} />
                <Text label="Member" value={member} onChange={setMember} />
              </>
            ) : (
              <Text
                label={section === "permissions" ? "Grantee" : "Name"}
                value={name}
                onChange={setName}
              />
            )}
            {section === "principals" && (
              <>
                {server ? (
                  <>
                    <Check
                      label="Windows login"
                      checked={windows}
                      onChange={setWindows}
                    />
                    {!windows && (
                      <Text
                        label="Password"
                        value={password}
                        onChange={setPassword}
                        type="password"
                      />
                    )}
                  </>
                ) : (
                  <>
                    <Text
                      label="Mapped login (empty = WITHOUT LOGIN)"
                      value={login}
                      onChange={setLogin}
                    />
                    <Text
                      label="Default schema"
                      value={schema}
                      onChange={setSchema}
                    />
                  </>
                )}
              </>
            )}
            {section === "permissions" && (
              <>
                <Choice
                  label="Permission action"
                  value={state}
                  onChange={setState}
                  options={["GRANT", "DENY", "REVOKE"]}
                />
                <Choice
                  label="Permission"
                  value={permission}
                  onChange={setPermission}
                  options={
                    server
                      ? [
                          "CONNECT SQL",
                          "VIEW SERVER STATE",
                          "VIEW ANY DEFINITION",
                          "ALTER ANY LOGIN",
                          "ALTER ANY SERVER ROLE",
                          "CONTROL SERVER",
                        ]
                      : [
                          "SELECT",
                          "INSERT",
                          "UPDATE",
                          "DELETE",
                          "EXECUTE",
                          "ALTER",
                          "REFERENCES",
                          "VIEW DEFINITION",
                          "CONTROL",
                          "CONNECT",
                        ]
                  }
                />
                {!server && (
                  <>
                    <Choice
                      label="Securable"
                      value={securable}
                      onChange={setSecurable}
                      options={["database", "schema", "object"]}
                    />
                    {securable !== "database" && (
                      <Text
                        label="Schema"
                        value={schema}
                        onChange={setSchema}
                      />
                    )}
                    {securable === "object" && (
                      <Text
                        label="Object"
                        value={object}
                        onChange={setObject}
                      />
                    )}
                  </>
                )}
              </>
            )}
            {section === "audits" && (
              <Text
                label="Server-side audit directory (trailing slash)"
                value={path}
                onChange={setPath}
              />
            )}
            {section === "auditSpecifications" && (
              <>
                <Text
                  label="Existing server audit"
                  value={audit}
                  onChange={setAudit}
                />
                <Choice
                  label="Audit action group"
                  value={auditAction}
                  onChange={setAuditAction}
                  options={
                    server
                      ? [
                          "FAILED_LOGIN_GROUP",
                          "SUCCESSFUL_LOGIN_GROUP",
                          "SERVER_PRINCIPAL_CHANGE_GROUP",
                          "SERVER_ROLE_MEMBER_CHANGE_GROUP",
                          "SERVER_PERMISSION_CHANGE_GROUP",
                          "AUDIT_CHANGE_GROUP",
                        ]
                      : [
                          "DATABASE_OBJECT_ACCESS_GROUP",
                          "DATABASE_PRINCIPAL_CHANGE_GROUP",
                          "DATABASE_ROLE_MEMBER_CHANGE_GROUP",
                          "DATABASE_PERMISSION_CHANGE_GROUP",
                          "SCHEMA_OBJECT_CHANGE_GROUP",
                          "SCHEMA_OBJECT_ACCESS_GROUP",
                        ]
                  }
                />
              </>
            )}
          </div>
          <Operation
            context={
              (server && section === "permissions") || section === "audits" || (server && section === "auditSpecifications")
                ? { ...context, database: "master" }
                : context
            }
            script={script}
            label="Preview security changes"
          />
        </>
      )}
      {section === "permissions" && (
        <>
          <h2 className="border-b pb-2 text-sm font-medium">
            Effective permissions of the current login
          </h2>
          <Notice>
            Explicit permission rows do not include every permission inherited
            through roles. Use the current-login effective-permission query
            below.
          </Notice>
          <ReadTable
            context={context}
            resource={{ kind: "effectivePermissions", server }}
          />
        </>
      )}
    </div>
  );
}

export function Encryption({ context }: { context: Context }) {
  const [area, setArea] = useState("tde"),
    [operation, setOperation] = useState("enable"),
    [certificate, setCertificate] = useState(""),
    [masterPassword, setMasterPassword] = useState(""),
    [certificatePath, setCertificatePath] = useState(""),
    [privatePath, setPrivatePath] = useState(""),
    [backupPassword, setBackupPassword] = useState(""),
    [schema, setSchema] = useState("dbo"),
    [table, setTable] = useState(""),
    [column, setColumn] = useState(""),
    [key, setKey] = useState(""),
    [masterKey, setMasterKey] = useState(""),
    [keyPath, setKeyPath] = useState(""),
    [encryptionType, setEncryptionType] = useState("Deterministic");
  let script = "";
  if (area === "tde" && context.database) {
    if (operation === "disable")
      script = `ALTER DATABASE ${n(context.database)} SET ENCRYPTION OFF;`;
    if (operation === "enable" && certificate)
      script = `CREATE DATABASE ENCRYPTION KEY WITH ALGORITHM=AES_256 ENCRYPTION BY SERVER CERTIFICATE ${n(certificate)};\nALTER DATABASE ${n(context.database)} SET ENCRYPTION ON;`;
    if (operation === "rotate" && certificate)
      script = `ALTER DATABASE ENCRYPTION KEY ENCRYPTION BY SERVER CERTIFICATE ${n(certificate)};`;
    if (
      operation === "certificate" &&
      certificate &&
      certificatePath &&
      privatePath &&
      backupPassword &&
      masterPassword
    )
      script = `USE [master];\nIF NOT EXISTS(SELECT 1 FROM sys.symmetric_keys WHERE name=N'##MS_DatabaseMasterKey##') CREATE MASTER KEY ENCRYPTION BY PASSWORD=${l(masterPassword)};\nCREATE CERTIFICATE ${n(certificate)} WITH SUBJECT=N'Quervio TDE';\nBACKUP CERTIFICATE ${n(certificate)} TO FILE=${l(certificatePath)} WITH PRIVATE KEY(FILE=${l(privatePath)},ENCRYPTION BY PASSWORD=${l(backupPassword)});`;
    if (
      operation === "backup" &&
      certificate &&
      certificatePath &&
      privatePath &&
      backupPassword
    )
      script = `USE [master];\nBACKUP CERTIFICATE ${n(certificate)} TO FILE=${l(certificatePath)} WITH PRIVATE KEY(FILE=${l(privatePath)},ENCRYPTION BY PASSWORD=${l(backupPassword)});`;
  }
  if (area === "keys" && operation === "register" && masterKey && keyPath)
    script = `CREATE COLUMN MASTER KEY ${n(masterKey)} WITH(KEY_STORE_PROVIDER_NAME=N'MSSQL_CERTIFICATE_STORE',KEY_PATH=${l(keyPath)});`;
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <Choice
        label="Encryption area"
        value={area}
        onChange={(v) => {
          setArea(v);
          setOperation(v === "keys" ? "create" : "enable");
        }}
        options={[
          ["tde", "Transparent Data Encryption"],
          ["keys", "Always Encrypted keys"],
          ["columns", "Always Encrypted columns"],
        ]}
      />
      {area === "tde" && (
        <>
          <ReadTable context={context} resource={{ kind: "encryption" }} />
          <ReadTable
            context={{ ...context, database: "master" }}
            resource={{ kind: "certificates" }}
          />
          <Choice
            label="TDE operation"
            value={operation}
            onChange={setOperation}
            options={[
              ["enable", "Create database encryption key and enable"],
              ["disable", "Disable encryption"],
              ["rotate", "Rotate protector certificate"],
              ["certificate", "Create and back up server certificate"],
              ["backup", "Back up server certificate"],
            ]}
          />
          <Text
            label="Server certificate in master"
            value={certificate}
            onChange={setCertificate}
          />
          {["certificate", "backup"].includes(operation) && (
            <>
              <Text
                label="Certificate backup path on SQL Server"
                value={certificatePath}
                onChange={setCertificatePath}
              />
              <Text
                label="Private key backup path on SQL Server"
                value={privatePath}
                onChange={setPrivatePath}
              />
              <Text
                label="Private key backup password"
                value={backupPassword}
                onChange={setBackupPassword}
                type="password"
              />
              {operation === "certificate" && (
                <Text
                  label="Master key password (used only if absent)"
                  value={masterPassword}
                  onChange={setMasterPassword}
                  type="password"
                />
              )}
            </>
          )}
          <Operation
            context={context}
            script={script}
            label="Preview TDE operation"
          />
          <Notice>
            Certificate and private-key backups are required to restore
            TDE-protected databases on another server. Disabling encryption does
            not delete the certificate.
          </Notice>
        </>
      )}
      {area === "keys" && (
        <>
          <ReadTable context={context} resource={{ kind: "columnKeys" }} />
          <Choice
            label="Key operation"
            value={operation}
            onChange={setOperation}
            options={[
              ["create", "Create certificate, CMK and CEK"],
              ["register", "Register an existing certificate CMK"],
              ["rotate", "Add a new CMK protector to a CEK"],
            ]}
          />
          <Text
            label="Column master key name"
            value={masterKey}
            onChange={setMasterKey}
          />
          <Text
            label="Column encryption key name"
            value={key}
            onChange={setKey}
          />
          {operation === "create" ? (
            <>
              <Text
                label="Local .pfx backup destination"
                value={keyPath}
                onChange={setKeyPath}
              />
              <Text
                label="PFX backup password"
                value={backupPassword}
                onChange={setBackupPassword}
                type="password"
              />
              <BridgeOperation
                context={context}
                action="createColumnKeys"
                args={{ masterKey, key, backupPath: keyPath, backupPassword }}
                label="Create and back up column keys"
                write
              />
            </>
          ) : operation === "rotate" ? (
            <BridgeOperation
              context={context}
              action="rotateMasterKey"
              args={{ masterKey, key }}
              label="Add CEK protector"
              write
            />
          ) : (
            <>
              <Text
                label="Certificate path (CurrentUser/My/thumbprint)"
                value={keyPath}
                onChange={setKeyPath}
              />
              <Operation
                context={context}
                script={script}
                label="Preview CMK registration"
              />
            </>
          )}
        </>
      )}
      {area === "columns" && (
        <>
          <ReadTable context={context} resource={{ kind: "columnKeys" }} />
          <div className="grid grid-cols-3 gap-3">
            <Text label="Schema" value={schema} onChange={setSchema} />
            <Text label="Table" value={table} onChange={setTable} />
            <Text label="Column" value={column} onChange={setColumn} />
            <Text
              label="Target column encryption key"
              value={key}
              onChange={setKey}
            />
            <Choice
              label="Encryption type"
              value={encryptionType}
              onChange={setEncryptionType}
              options={["Deterministic", "Randomized"]}
            />
            <Choice
              label="Operation"
              value={operation}
              onChange={setOperation}
              options={[
                ["enable", "Encrypt / rotate CEK"],
                ["disable", "Decrypt existing column"],
              ]}
            />
          </div>
          <BridgeOperation
            context={context}
            action="columnEncryption"
            args={{
              schema,
              table,
              column,
              key,
              encryptionType,
              decrypt: operation === "disable",
            }}
            label="Migrate column encryption"
            write
          />
          <Notice>
            SqlClient and SMO migrate data using the current Windows user's
            certificate keys. This operation can read and rewrite the entire
            column.
          </Notice>
        </>
      )}
    </div>
  );
}

export function MicrosoftQuery({ context }: { context: Context }) {
  const [sets,setSets]=useState<DataTable[]>([]),[lastRun,setLastRun]=useState<Date|null>(null);
  const [query, setQuery] = useState(""),
    [parameters, setParameters] = useState("[]"),
    [entra, setEntra] = useState(false);
  let parsed: unknown = [],
    error = "";
  try {
    parsed = JSON.parse(parameters);
    if (!Array.isArray(parsed)) throw new Error("Parameters must be an array.");
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  return (
    <div className="flex flex-col gap-3 overflow-auto">
      <Notice>
        Microsoft SqlClient query with Always Encrypted enabled. Each execution
        uses a separate session and closes it on completion; open transactions
        are rolled back when it closes.
      </Notice>
      <Check
        label="Microsoft Entra interactive authentication"
        checked={entra}
        onChange={setEntra}
      />
      <textarea
        aria-label="Microsoft SQL query"
        className={cn(textareaClass, "min-h-56")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      <label className="text-xs text-muted-foreground">
        Typed parameters: JSON array with name, type, value and optional size,
        precision, scale
      </label>
      <textarea
        aria-label="Typed SqlClient parameters"
        className={cn(textareaClass, "min-h-28")}
        value={parameters}
        onChange={(e) => setParameters(e.target.value)}
      />
      {error ? (
        <Notice error>{error}</Notice>
      ) : (
        <BridgeOperation
          context={context}
          action="encryptedQuery"
          args={{
            query,
            parametersJson: parameters,
            entra,
            timeout: 30,
            maxRows: 1000,
          }}
          label="Review and execute Microsoft query"
          write
          onResult={value=>{const result=value as {sets:DataTable[]};if(!Array.isArray(result.sets))throw new Error("Invalid query response.");setSets(result.sets);setLastRun(new Date());}}
        />
      )}
      {lastRun && <p className="text-xs text-muted-foreground">Results from {lastRun.toLocaleTimeString()}</p>}
      {sets.map((data,index)=><DataGrid key={index} data={data}/>)}
    </div>
  );
}
