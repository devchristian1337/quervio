# Quervio branding

Reference from the Quervio branding package, kept after its integration.

- `design-tokens.json`: the dark palette and type roles. The values in use live in `src/lib/themes.ts` (theme "Quervio Dark").
- `SOURCES.json`: where each asset came from, with its SHA-256. The `assets` paths are those of the original package: the files are now in `src/assets/` (Q Prisma v2 PNGs) and `src/assets/fonts/` (Inter, JetBrains Mono and their licences).
- `src-tauri/icons/source.png`: the transparent Q Prisma v2 reframed for native icons and enlarged further by the user, with less padding so the logo appears larger in the Windows taskbar. Its provenance, current hash and initial built-in imagegen prompts are recorded in `SOURCES.json` under `nativeIcon`. The original in-app branding assets retain their original framing.
- Regenerate the native icons with `node node_modules/@tauri-apps/cli/tauri.js icon src-tauri/icons/source.png --output target/icon-generation`, then copy the existing PNG, ICO and ICNS variants into `src-tauri/icons/`.
