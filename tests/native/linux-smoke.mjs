import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "linux");
assert.equal(process.env.QUERVIO_PRIVATE_NATIVE_TEST, "1", "Use scripts/test-linux-native.sh");
const [application, output] = process.argv.slice(2);
const flatpak = process.env.QUERVIO_NATIVE_FORMAT === "flatpak";
const endpoint = "http://127.0.0.1:4444";
const driver = spawn("tauri-driver", ["--port", "4444", "--native-port", "4445"], {
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let logs = "";
driver.stdout.on("data", bytes => { logs = (logs + bytes).slice(-16000); });
driver.stderr.on("data", bytes => { logs = (logs + bytes).slice(-16000); });
driver.on("error", error => { logs += String(error); });
let session;

async function request(method, route, body) {
  const response = await fetch(endpoint + route, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result));
  return result.value;
}

async function execute(script, args = []) {
  return request("POST", `/session/${session}/execute/sync`, { script, args });
}

async function invoke(command, args = {}) {
  const result = await request("POST", `/session/${session}/execute/async`, {
    script: `const [command, args, done] = arguments;
      window.__TAURI_INTERNALS__.invoke(command, args).then(
        value => done({value}), error => done({error: String(error)}));`,
    args: [command, args],
  });
  assert.equal(result.error, undefined, result.error);
  return result.value;
}

function publicPayload() {
  // Extract-and-run intentionally makes extracted directories private.
  // Inspect the SquashFS metadata to check the root-owned mounted package.
  const offset = spawnSync(application, ["--appimage-offset"], { encoding: "utf8" });
  assert.equal(offset.status, 0);
  assert.match(offset.stdout.trim(), /^\d+$/);
  const listing = spawnSync("unsquashfs", ["-ll", "-o", offset.stdout.trim(), application], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(listing.status, 0, listing.stderr);
  let checked = 0;
  for (const line of listing.stdout.split("\n")) {
    if (!line.includes("/usr/lib/Quervio/") || !/\/(microsoft|sqltools)(\/|$)/.test(line)) continue;
    const mode = line.trim().split(/\s+/)[0];
    if (mode.startsWith("l")) continue;
    assert.equal(mode[7], "r", `Private package resource: ${line}`);
    if (mode.startsWith("d") || /\/(Quervio.MicrosoftBridge|MicrosoftSqlToolsServiceLayer)$/.test(line)) {
      assert.equal(mode[9], "x", `Non-traversable package resource: ${line}`);
    }
    checked++;
  }
  assert.ok(checked > 100, "The package must contain the Microsoft payloads");
}

try {
  for (let attempt = 0; ; attempt++) {
    try { await request("GET", "/status"); break; }
    catch (error) { if (attempt >= 100) throw error; await delay(100); }
  }
  const created = await request("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application } } },
  });
  session = created.sessionId;
  assert.ok(session);
  await request("POST", `/session/${session}/timeouts`, { script: 20000, pageLoad: 60000 });
  for (let attempt = 0; ; attempt++) {
    const ready = await execute("return !!window.__TAURI_INTERNALS__ && !!document.querySelector('#root')?.textContent?.trim()");
    if (ready) break;
    assert.ok(attempt < 200, "The packaged frontend did not render");
    await delay(100);
  }
  const rendered = await execute(`return {
    platform: navigator.platform,
    background: getComputedStyle(document.body).backgroundColor,
    text: document.body.innerText,
    width: innerWidth,
    height: innerHeight
  }`);
  assert.match(rendered.platform, /Linux/i);
  assert.notEqual(rendered.background, "rgba(0, 0, 0, 0)");
  assert.notEqual(rendered.background, "transparent");
  assert.ok(rendered.width >= 900 && rendered.height >= 600);
  assert.ok(rendered.text.length > 100, "The app rendered an empty surface");
  assert.deepEqual(await invoke("list_connections"), [], "The profile must start empty");
  const dataDir = await invoke("settings_data_dir");
  assert.ok(dataDir.startsWith(process.env.XDG_DATA_HOME + path.sep));
  const dependencies = await invoke("management_dependencies");
  assert.equal(dependencies.length, 2);
  assert.ok(dependencies.every(dependency => dependency.available), JSON.stringify(dependencies));
  assert.ok(dependencies.every(dependency => !dependency.path.endsWith(".exe")));
  assert.ok(dependencies.every(dependency => dependency.path.includes(flatpak ? "/app/lib/Quervio/" : "/usr/lib/Quervio/")), "Use components inside the package");
  if (!flatpak) publicPayload();

  const connection = await invoke("save_connection", {
    connection: {
      id: "", name: "Disposable Linux smoke test", group: null,
      server: "tcp:127.0.0.1,1", authentication: { kind: "sql", userName: "test-only" },
      defaultDatabase: null, environment: "test", encrypt: "mandatory", trustServerCertificate: false,
    },
    password: "disposable-linux-smoke-password",
  });
  assert.ok(connection.id);
  const onEvent = await execute("return window.__TAURI_INTERNALS__.transformCallback(() => {})");
  const bridgeVersion = await invoke("management_bridge", {
    id: connection.id, database: null,
    request: { action: "version", arguments: {}, confirmed: false },
    previewToken: null, onEvent: `__CHANNEL__:${onEvent}`,
  });
  assert.equal(bridgeVersion.version, "1.0");
  for (const action of ["columnEncryption", "createColumnKeys", "rotateMasterKey"]) {
    const request = { action, arguments: {}, confirmed: true };
    const preview = await invoke("management_bridge_prepare", { id: connection.id, database: null, request });
    await assert.rejects(() => invoke("management_bridge", {
      id: connection.id, database: null, request,
      previewToken: preview.token, onEvent: `__CHANNEL__:${onEvent}`,
    }), /Windows certificate store/);
  }
  const stored = await readFile(path.join(dataDir, "connections.json"), "utf8");
  assert.ok(!stored.includes("disposable-linux-smoke-password"));
  await invoke("delete_connection", { id: connection.id });
  assert.deepEqual(await invoke("list_connections"), []);
  let sqlServer;
  if (process.env.QUERVIO_TEST_DISPOSABLE_SQL === "1") {
    assert.equal(process.env.QUERVIO_TEST_SERVER, "tcp:127.0.0.1,14333");
    const saved = await invoke("save_connection", {
      connection: { ...connection, id: "", server: process.env.QUERVIO_TEST_SERVER, trustServerCertificate: true,
        authentication: { kind: "sql", userName: process.env.QUERVIO_TEST_USER } },
      password: process.env.QUERVIO_TEST_PASSWORD,
    });
    sqlServer = await invoke("explorer_connect", { id: saved.id });
    assert.match(sqlServer.version, /^16\./, "The disposable fixture must be SQL Server 2022");
    const databases = await invoke("explorer_databases", { id: saved.id });
    assert.ok(databases.some(database => database.name === "master"));
    await invoke("explorer_disconnect", { id: saved.id });
    await invoke("delete_connection", { id: saved.id });
  }
  const scriptPath = path.join(dataDir, "smoke.sql");
  const sql = "SELECT N'Linux 漢字';\n";
  await invoke("file_write", { path: scriptPath, text: sql });
  // The script writer deliberately uses CRLF, also on Linux.
  assert.equal((await invoke("file_read", { path: scriptPath })).replaceAll("\r\n", "\n"), sql);
  await mkdir(output, { recursive: true });
  const screenshot = await request("GET", `/session/${session}/screenshot`);
  await writeFile(path.join(output, "linux-native.png"), Buffer.from(screenshot, "base64"));
  await writeFile(path.join(output, "verification.json"), JSON.stringify({
    application, format: flatpak ? "flatpak" : "appimage", platform: rendered.platform, background: rendered.background,
    size: [rendered.width, rendered.height], dependencies, sqlServer, checks: [
      "packaged WebKitGTK rendering", "opaque Linux theme", "native Tauri IPC",
      "isolated profile", "bundled Microsoft components", "native keyring save/delete",
      "Unicode SQL file round trip", "Microsoft bridge launched through native IPC",
      ...(!flatpak ? ["component permissions usable when the mounted package is owned by root"] : []),
      "Windows certificate operations rejected without connecting",
      ...(sqlServer ? ["packaged SQL Server login and Object Explorer catalogue"] : []),
    ],
  }, null, 2));
  console.log(`Linux ${flatpak ? "Flatpak" : "AppImage"} native smoke passed: rendering, IPC, components, keyring and SQL files.`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  if (session) await request("DELETE", `/session/${session}`).catch(() => {});
  if (driver.pid) {
    try { process.kill(-driver.pid, "SIGTERM"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
