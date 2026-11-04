# Quervio

A fast, modern SQL Server management tool for Windows 11 and Linux, inspired by SSMS. Built with Tauri v2, React and Rust.

## Download and install

Public installers are available in [GitHub Releases](https://github.com/devchristian1337/quervio/releases/latest).

| Platform | Downloads |
| --- | --- |
| Windows 11 x64 | [Installer](https://github.com/devchristian1337/quervio/releases/latest/download/Quervio.App-win-Setup.exe) |
| Linux Intel/AMD x64 | [Flatpak](https://github.com/devchristian1337/quervio/releases/latest/download/Quervio-linux-x64.flatpak) · [DEB](https://github.com/devchristian1337/quervio/releases/latest/download/Quervio-linux-x64.deb) · [RPM](https://github.com/devchristian1337/quervio/releases/latest/download/Quervio-linux-x64.rpm) · [AppImage](https://github.com/devchristian1337/quervio/releases/latest/download/Quervio-linux-x64.AppImage) |

On Linux, Flatpak provides a common runtime across distributions; DEB and RPM
integrate with the system package manager. Install the downloaded Flatpak through
your software manager, or follow the [Linux installation instructions](docs/linux.md#installazione).
No .NET SDK, Node.js or Rust installation is required to use Quervio. Saved
passwords use the desktop's unlocked Secret Service keyring. Windows updates
automatically; Linux updates by installing the newer package.

The current public Linux binaries target Intel/AMD x64. ARM64 build support is
prepared in the source workflow; ARM64 binaries are not part of this release.

Linux packaging, requirements and the actual verification scope are documented in
[Linux support](docs/linux.md). Linux support does not imply compatibility with
every historical distribution or with Windows-only certificate operations.

- Domain language: [GLOSSARY.md](GLOSSARY.md)
- Architecture decisions: [docs/adr](docs/adr)

## Layout

| Path | What lives there |
|---|---|
| `crates/quervio-core` | Domain logic with no Tauri dependency: Server access (`mssql-tds`), Batch splitting, Destructive Statement detection, scripting, Result Set storage |
| `src-tauri` | Thin Tauri shell: commands, events, window |
| `src` | React + TypeScript frontend (shadcn/ui, Tailwind, Monaco, Glide Data Grid, Zustand) |

## Develop

Requires Rust (MSVC on Windows, native GNU toolchain on Linux), Node 24+ and pnpm.

```bash
pnpm install
pnpm tauri dev
```

On Windows, WebView2's browser shortcuts (page search, reload, print, zoom and
DevTools) are disabled. Quervio commands, Monaco editing shortcuts and ordinary
text editing keep their own keyboard handling.

**Search commands** in the top bar (Ctrl+Shift+P, configurable in Settings →
Shortcuts) searches quick actions, management tools, open tabs and saved
connections. Use the arrow keys and Enter to select, or Esc to return to the
previous control. Choosing a saved connection opens a new query on it.

On first launch, a short spotlight tour introduces connections, Object Explorer,
query tabs, command search, Tools and Settings. Navigate with Next/Back or the
arrow keys; Esc or Close ends it. Finishing or dismissing the tour records a local
`quervio.tour.seen` flag in the app's WebView storage so it stays closed on later
launches. It follows the selected theme and reduced-motion preference, keeps
keyboard focus inside the tour and blocks workspace shortcuts while open.

## Test

```bash
cargo test --workspace
pnpm test
```

Integration tests run against SQL Server 2022 in Docker. Copy `.env.example` to `.env` first, then:

```bash
docker compose up -d --wait
cargo test --workspace -- --ignored --skip linux_keyring_round_trip_and_profile_isolation
```

The Linux keyring integration runs separately on a private bus with
`bash scripts/test-linux-keyring.sh`; see [Linux support](docs/linux.md).

## Build the installer

This section describes Windows. On Linux use `bash scripts/pack-linux.sh`, with
`--flatpak` to also create a Flatpak bundle after installing its build runtime;
see [Linux support](docs/linux.md).

Quervio installs and updates itself with [Velopack](https://docs.velopack.io) ([ADR 0005](docs/adr/0005-installer-velopack.md)). With the .NET SDK installed and the Microsoft bridge built (`scripts/build-microsoft.ps1`):

```powershell
.\scripts\pack-velopack.ps1
```

Produces an unsigned `Quervio.App-win-Setup.exe` and the update packages under `target/velopack/releases`. Add `-Publish` to upload them as the GitHub Release `v<version>` (it uses `gh auth token`); installed copies find it from Settings › About, and check once at start-up. The version comes from `src-tauri/tauri.conf.json`.

`pnpm tauri build` still produces the old NSIS installer under `target/release/bundle/nsis`, which cannot update itself.

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
  and line information. Reading include files requires separate consent before
  any path is resolved or opened, including network paths, mapped drives, links
  and nested includes. The final review includes local commands, output paths
  and server switches. Local commands require that explicit confirmation.
- Administrative SQL previews are tied to the opened destination session, expire
  after five minutes and can be used once. Microsoft operations also validate the
  destination and approved arguments. Long operations can be cancelled.
- Maintenance flows generate SQL Server Agent jobs, including schedules and
  success/failure routing. They run with Quervio closed. They are Quervio flows,
  not SSIS Maintenance Plans.
- CSV/Excel export is available from the results grid and the transfer wizard.
  Large exports stream on the backend. Truncated cell values cannot be exported
  as complete data. Excel uses text cells to retain numeric/date precision.
  CSV rejects formula-like text in cells and column names (including formulas
  hidden behind leading whitespace), rather than changing exported values.
  Signed numeric literals remain supported. Use XLSX for formula-like text.
- Import supports CSV, Excel and installed 64-bit ODBC drivers, column mapping,
  source preview, conversion checks and one destination transaction. Quervio CSV
  exports use `\N` for NULL and escape leading backslashes; enable the corresponding
  import option when reading those exports.
- DacFx handles `.dacpac`/`.bacpac`; SMO scripts structure/data and dependencies.
  DACPAC preview and publish hash and load the same immutable byte snapshot;
  publish rejects a snapshot that differs from the approved hash.
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
CSV/Excel round trips, NULL versus empty strings, Unicode, decimal(38), binary
conversion, formula rejection/text cells and DACPAC snapshot/hash consistency
without connecting to SQL Server.

SQL integration tests remain opt-in and use only `QUERVIO_TEST_*` settings. The
new management tests cover metadata, non-executing estimated plans, untruncated
plan XML and stopping administrative batches after errors. SQL Server 2012–2025,
Windows authentication, Azure SQL/Managed Instance, Agent, restore and encryption
must be validated on corresponding dedicated environments; compilation and mock
tests alone are not a compatibility certification.

### Verification — 2026-10-30

The TypeScript check, the production build, 96 frontend unit tests, eight browser
tests, the 84 tests of the Rust workspace suite, the 28 SQL integration tests and
the Microsoft helper's nine self-tests pass. The SQL integration tests run against
the SQL Server 2022 container from `docker-compose.yml`, started with
`MSSQL_AGENT_ENABLED=true` for the Agent checks.

On 2026-10-28, on that container, the SQL the management tools generate was
executed for real: table and foreign-key designers, backup/restore chains with
STOPAT and MOVE, maintenance jobs run through SQL Server Agent, Query Store
forcing, Extended Events, logins/users/roles/permissions, SQL Server Audit, TDE
and every read the tools issue. The helper's SMO scripting, DacFx extract/publish/bacpac, CSV/Excel/
ODBC import and export round trips, Microsoft Query and cancellation were run
the same way. The desktop app was also driven by hand against that server.

Not covered: Windows and Entra authentication, Azure SQL, SQL Server versions
other than 2022, URL backups, and Always Encrypted operations that create
certificates in the Windows store. SQL Tools Service needs the component
installed by `.\scripts\install-sqltools.ps1`. Published Microsoft binaries and
SDK installations are local build artifacts and are intentionally not tracked in Git.
