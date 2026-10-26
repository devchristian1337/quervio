# Querydeck

A fast, modern SQL Server management tool for Windows 11, inspired by SSMS. Built with Tauri v2, React and Rust.

- Domain language: [GLOSSARY.md](GLOSSARY.md)
- Architecture decisions: [docs/adr](docs/adr)

## Layout

| Path | What lives there |
|---|---|
| `crates/querydeck-core` | Domain logic with no Tauri dependency: Server access (`mssql-tds`), Batch splitting, Destructive Statement detection, scripting, Result Set storage |
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
