// Cross-platform launcher for real desktop E2E tests (WebdriverIO + @wdio/tauri-service).
// Guarantees an isolated temporary profile (never touches user Saved Connections or Querydeck data)
// and optionally provisions a disposable Docker SQL Server 2022 container with ephemeral credentials.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = fileURLToPath(new URL("../", import.meta.url));
const isWindows = process.platform === "win32";

const { values } = parseArgs({
  options: {
    "with-sql": { type: "boolean", default: false },
    "skip-build": { type: "boolean", default: false },
    "sql-version": { type: "string", default: "2022" },
    spec: { type: "string" },
    binary: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

function run(command, args, { env = process.env, capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      shell: false,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0 || (allowFailure && !signal)) {
        resolve({ code: code ?? 1, stdout: stdout.trim(), stderr: stderr.trim() });
      } else {
        reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})${stderr ? `: ${stderr}` : ""}`));
      }
    });
  });
}

let containerName = null;
let ephemeralPassword = null;

async function startDisposableSql(version) {
  const engine = await run("docker", ["info", "--format", "{{.OSType}}"], { capture: true });
  if (engine.stdout !== "linux") {
    throw new Error("Docker must have a running Linux engine to run desktop E2E tests with --with-sql.");
  }
  const image = `mcr.microsoft.com/mssql/server:${version}-latest`;
  const hasImage = await run("docker", ["image", "inspect", image], { capture: true, allowFailure: true });
  if (hasImage.code !== 0) {
    console.log(`Pulling isolated SQL Server ${version} image (${image})...`);
    await run("docker", ["pull", image]);
  }
  containerName = `quervio-e2e-sql-${randomUUID()}`;
  ephemeralPassword = `Qv-${randomBytes(24).toString("hex")}-Aa1!`;
  if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${ephemeralPassword}`);

  console.log(`Starting isolated SQL Server ${version} container (${containerName})...`);
  await run(
    "docker",
    [
      "create",
      "--name",
      containerName,
      "--memory",
      "3g",
      "--publish",
      "127.0.0.1::1433",
      "-e",
      "ACCEPT_EULA=Y",
      "-e",
      "MSSQL_PID=Developer",
      "-e",
      "MSSQL_AGENT_ENABLED=true",
      "-e",
      "MSSQL_SA_PASSWORD",
      image,
    ],
    { env: { ...process.env, MSSQL_SA_PASSWORD: ephemeralPassword }, capture: true },
  );
  await run("docker", ["start", containerName], { capture: true });

  const portOut = await run("docker", ["port", containerName, "1433/tcp"], { capture: true });
  const port = portOut.stdout.match(/^127\.0\.0\.1:(\d+)$/m)?.[1];
  if (!port) throw new Error(`Could not determine mapped SQL port for ${containerName}.`);

  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const check = await run(
      "docker",
      [
        "exec",
        "-e",
        "SQLCMDPASSWORD",
        containerName,
        "/opt/mssql-tools18/bin/sqlcmd",
        "-C",
        "-S",
        "localhost",
        "-U",
        "sa",
        "-l",
        "2",
        "-b",
        "-Q",
        "SELECT 1;",
      ],
      { env: { ...process.env, SQLCMDPASSWORD: ephemeralPassword }, capture: true, allowFailure: true },
    );
    if (check.code === 0) {
      ready = true;
      break;
    }
    if (attempt % 15 === 0) console.log("Waiting for isolated SQL Server container to accept connections...");
    await delay(2000);
  }
  if (!ready) throw new Error("Isolated SQL Server container did not become ready in time.");

  return {
    QUERVIO_E2E_SQL_SERVER: `tcp:127.0.0.1,${port}`,
    QUERVIO_E2E_SQL_USER: "sa",
    QUERVIO_E2E_SQL_PASSWORD: ephemeralPassword,
  };
}

async function stopDisposableSql() {
  if (!containerName) return;
  const target = containerName;
  containerName = null;
  await run("docker", ["rm", "--force", target], { capture: true, allowFailure: true });
}

const profileRoot = await mkdtemp(path.join(os.tmpdir(), "quervio-e2e-profile-"));
const dataDir = path.join(profileRoot, "data");
const webviewDir = path.join(profileRoot, "webview2");
const xdgData = path.join(profileRoot, "xdg-data");
const xdgConfig = path.join(profileRoot, "xdg-config");
const xdgCache = path.join(profileRoot, "xdg-cache");
const artifactsDir = path.join(root, "target", "e2e-desktop-results");

await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(webviewDir, { recursive: true }),
  mkdir(xdgData, { recursive: true }),
  mkdir(xdgConfig, { recursive: true }),
  mkdir(xdgCache, { recursive: true }),
  mkdir(artifactsDir, { recursive: true }),
]);

let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await stopDisposableSql();
  await rm(profileRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    void cleanup().finally(() => process.exit(sig === "SIGINT" ? 130 : 143));
  });
}

try {
  if (!values["skip-build"]) {
    console.log("Building production frontend bundle (dist/)...");
    const viteBin = path.join(root, "node_modules", "vite", "bin", "vite.js");
    const tscBin = path.join(root, "node_modules", "typescript", "bin", "tsc");
    await run(process.execPath, [tscBin]);
    await run(process.execPath, [viteBin, "build"]);

    console.log("Building Quervio desktop binary with opt-in test-profile isolation...");
    await run("cargo", [
      "build",
      "--locked",
      "--manifest-path",
      "src-tauri/Cargo.toml",
      "--features",
      "test-profile,tauri/custom-protocol",
    ]);
  }

  let sqlEnv = {};
  if (values["with-sql"]) {
    sqlEnv = await startDisposableSql(values["sql-version"]);
  }

  const binaryPath = path.resolve(
    values.binary ||
      process.env.QUERVIO_E2E_BINARY ||
      path.join(root, "target", "debug", isWindows ? "quervio.exe" : "quervio"),
  );

  const env = {
    ...process.env,
    ...sqlEnv,
    QUERVIO_E2E_BINARY: binaryPath,
    QUERVIO_TEST_DATA_DIR: dataDir,
    WEBVIEW2_USER_DATA_FOLDER: webviewDir,
    XDG_DATA_HOME: xdgData,
    XDG_CONFIG_HOME: xdgConfig,
    XDG_CACHE_HOME: xdgCache,
    QUERVIO_E2E_ARTIFACTS: artifactsDir,
    QUERVIO_E2E_VERBOSE: values.verbose ? "1" : "0",
  };
  // Never inherit local developer .env SQL credentials into E2E desktop sessions.
  delete env.QUERVIO_TEST_SERVER;
  delete env.QUERVIO_TEST_USER;
  delete env.QUERVIO_TEST_PASSWORD;

  const wdioCli = path.join(root, "node_modules", "@wdio", "cli", "bin", "wdio.js");
  const wdioArgs = [wdioCli, "run", path.join(root, "wdio.tauri.conf.ts")];
  if (values.spec) {
    wdioArgs.push("--spec", values.spec);
  }
  console.log(`Running WebdriverIO desktop E2E tests against ${path.relative(root, binaryPath)}...`);
  console.log(`Isolated profile directory: ${profileRoot}`);
  await run(process.execPath, wdioArgs, { env });
} catch (error) {
  const message = ephemeralPassword
    ? String(error).replaceAll(ephemeralPassword, "[redacted]")
    : String(error);
  console.error(message);
  process.exitCode = 1;
} finally {
  await cleanup();
}
