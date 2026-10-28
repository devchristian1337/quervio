# Quervio

A fast, modern SQL Server management tool for Windows 11, inspired by SSMS. Built with Tauri v2, React and Rust.

- Domain language: [GLOSSARY.md](GLOSSARY.md)
- Architecture decisions: [docs/adr](docs/adr)

## Layout

| Path | What lives there |
|---|---|
| `crates/quervio-core` | Domain logic with no Tauri dependency: Server access (`mssql-tds`), Batch splitting, Destructive Statement detection, scripting, Result Set storage |
| `src-tauri` | Thin Tauri shell: commands, events, window |
| `src` | React + TypeScript frontend (shadcn/ui, Tailwind, Monaco, Glide Data Grid, Zustand) |

## Develop

Requires Rust (MSVC toolchain), Node 24+ and pnpm.

```bash
pnpm install
pnpm tauri dev
```

## Test

```bash
cargo test --workspace
pnpm test
```

Integration tests run against SQL Server 2022 in Docker. Copy `.env.example` to `.env` first, then:

```bash
docker compose up -d --wait
cargo test --workspace -- --ignored
```

## Build the installer

```bash
pnpm tauri build
```

Produces an unsigned NSIS installer under `target/release/bundle/nsis`.

## Management workbench

The **Tools** menu opens independent tabs for Activity Monitor, execution plans,
Query Store, Extended Events/Profiler, table/view designers, relationship diagrams,
backup/restore, SQL Server Agent, visual maintenance flows, transfers, security,
auditing and encryption. Object Explorer also links these tools to their server
or database. Query tabs keep their dedicated Rust sessions.

- The query toolbar selects estimated/actual plans and SQLCMD mode. Plans support
  `.sqlplan` files, operator properties, warnings, estimated/actual rows and zoom.
- IntelliSense uses SQL Tools Service, with catalog completion and snippets as a
  fallback. Templates can be edited, imported and exported. Metadata is invalidated
  after schema operations and Object Explorer refreshes.
- SQLCMD expands variables/includes before confirmation and retains source file
  and line information. The review includes local commands, output paths and
  server switches. Local commands require that explicit confirmation.
- Administrative SQL previews are tied to the opened destination session, expire
  after five minutes and can be used once. Microsoft operations also validate the
  destination and approved arguments. Long operations can be cancelled.
- Maintenance flows generate SQL Server Agent jobs, including schedules and
  success/failure routing. They run with Quervio closed. They are Quervio flows,
  not SSIS Maintenance Plans.
- CSV/Excel export is available from the results grid and the transfer wizard.
  Large exports stream on the backend. Truncated cell values cannot be exported
  as complete data. Excel uses text cells to retain numeric/date precision.
- Import supports CSV, Excel and installed 64-bit ODBC drivers, column mapping,
  source preview, conversion checks and one destination transaction. Quervio CSV
  exports use `\N` for NULL and escape leading backslashes; enable the corresponding
  import option when reading those exports.
- DacFx handles `.dacpac`/`.bacpac`; SMO scripts structure/data and dependencies.
  SQL Server Audit, TDE and certificate-backed Always Encrypted have dedicated tools.
  Microsoft Entra interactive authentication is available for saved connections.

Server capabilities are detected per connection/database. Features depend on
server version, edition, platform and permissions; Query Store requires SQL Server
2016 or later. Monitoring is suspended for inactive tabs and hidden windows.
Server-side backup, `.xel` and audit paths are distinct from local import/export
paths. Azure SQL Database restore/retention use Azure Resource Manager and require
an Azure SQL resource ID and a suitably authorized Entra identity.

## Microsoft components

The core SQL editor remains Rust/TDS. Advanced Microsoft operations use an optional
local, self-contained .NET 10 helper. Build it with the .NET 10 SDK:

```powershell
.\scripts\build-microsoft.ps1
```

This publishes to `src-tauri/resources/microsoft`, which is detected in development
and included by the Tauri resource mapping when present. The installer user does
not need a .NET SDK. **Tools → Microsoft Components** can also select an existing
published helper and install the pinned official SQL Tools Service distribution;
its archive is checked against SHA-256 before extraction. Credentials and Entra
tokens are passed over standard input, never process arguments. Entra token caching
uses the Windows-protected Azure Identity cache.

Migrating existing Always Encrypted columns additionally requires Microsoft's
`SqlServer` PowerShell module, version 22 or later. The helper reports the missing
dependency instead of attempting a server-side `ALTER COLUMN` that would not
perform client-side encryption. Certificate/PFX and TDE certificate backup paths
are explicit operations. Existing key protectors are retained during CMK rotation.

**Microsoft Query** is a separate, parameterized SqlClient tool for Always Encrypted
and Entra queries. Each invocation owns a short-lived session; any transaction
left open is rolled back on close. Ordinary query tabs retain their existing
persistent sessions, transactions and temporary tables.

## Additional verification

```powershell
node node_modules/vitest/vitest.mjs run
node node_modules/@playwright/test/cli.js test
.\src-tauri\resources\microsoft\Quervio.MicrosoftBridge.exe --self-test
```

Browser tests use the explicitly labelled `?mock` development server. They verify
tool rendering, previews, preserved drafts, polling suspension, plan rendering and
desktop layout; they do not certify server operations. The helper self-test checks
CSV/Excel round trips, NULL versus empty strings, Unicode, decimal(38), and binary
conversion without connecting to SQL Server.

SQL integration tests remain opt-in and use only `QUERVIO_TEST_*` settings. The
new management tests cover metadata, non-executing estimated plans, untruncated
plan XML and stopping administrative batches after errors. SQL Server 2012–2025,
Windows authentication, Azure SQL/Managed Instance, Agent, restore and encryption
must be validated on corresponding dedicated environments; compilation and mock
tests alone are not a compatibility certification.

### Handoff checkpoint — 2026-10-28

This branch is an implementation checkpoint, not a completed server certification.
The latest TypeScript check and 62 frontend unit tests passed. Six browser tests
passed before the latest UI additions; the new import-mapping test and final UI
changes still need a complete rerun. SQL Tools Service initialization over stdio
was tested successfully, and the Microsoft helper passed five local data tests.

The latest Rust suite reported a process-test fixture failure: its shell child
exited before cancellation. The fixture now starts PowerShell directly; rerun the
suite to verify that adjustment. The 28 SQL integration tests were not run because
the local Docker engine was unavailable. Real SQL Server/Azure workflows, permissions,
restore, Agent and encryption remain to be exercised on dedicated environments.

Resume with `cargo test --workspace`, `pnpm test:ui`, and
`.\scripts\build-microsoft.ps1`. Published Microsoft binaries and SDK installations
are local build artifacts and are intentionally not tracked in Git.
