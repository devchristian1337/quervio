// Dedicated disposable SQL Server only. No saved connections or local .env.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { version: { type: "string", default: "2022" } } });
const majors = { "2019": "15", "2022": "16", "2025": "17" };
if (!Object.hasOwn(majors, values.version)) throw new Error("Supported test versions: 2019, 2022, 2025.");
const root = fileURLToPath(new URL("../", import.meta.url));
const name = `quervio-compatibility-${randomUUID()}`;
const image = `mcr.microsoft.com/mssql/server:${values.version}-latest`;
const reportDir = path.join(root, "target", "sql-compatibility", `${values.version}-${Date.now()}`);
const password = `Qv-${randomBytes(24).toString("hex")}-Aa1!`;
if (process.env.GITHUB_ACTIONS) console.log(`::add-mask::${password}`);

function run(command, args, { env = process.env, capture = false, allowFailure = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
    let stdout = "", stderr = "";
    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr?.on("data", (data) => { stderr += data; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 || allowFailure) resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() });
      else reject(new Error(`${command} failed (${code}). ${stderr}`));
    });
  });
}

let created = false;
const report = { requestedVersion: values.version, image, startedAt: new Date().toISOString(), status: "failed" };
try {
  const engine = await run("docker", ["info", "--format", "{{.OSType}}"], { capture: true });
  if (engine.stdout !== "linux") throw new Error("Docker must have a running Linux engine before the SQL tests can start.");
  await mkdir(reportDir, { recursive: true });
  console.log(`Refreshing the official SQL Server ${values.version} image.`);
  await run("docker", ["pull", image]);
  console.log(`Starting isolated SQL Server ${values.version} test container.`);
  // Only the variable name reaches the command line, never its value.
  await run("docker", ["create", "--name", name, "--memory", "3g", "--publish", "127.0.0.1::1433",
    "-e", "ACCEPT_EULA=Y", "-e", "MSSQL_PID=Developer", "-e", "MSSQL_AGENT_ENABLED=true",
    "-e", "MSSQL_SA_PASSWORD", image], { env: { ...process.env, MSSQL_SA_PASSWORD: password }, capture: true });
  created = true;
  await run("docker", ["start", name], { capture: true });
  const port = (await run("docker", ["port", name, "1433/tcp"], { capture: true })).stdout.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Could not determine the dedicated test container port.");
  report.imageId = (await run("docker", ["inspect", "--format", "{{.Image}}", name], { capture: true })).stdout;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const result = await run("docker", ["exec", "-e", "SQLCMDPASSWORD", name,
      "/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "localhost", "-U", "sa", "-l", "2", "-b", "-Q", "SELECT 1;"],
    { env: { ...process.env, SQLCMDPASSWORD: password }, capture: true, allowFailure: true });
    if (result.code === 0) { ready = true; break; }
    if (attempt % 15 === 0) console.log("Waiting for the dedicated SQL Server to accept connections...");
    await delay(2000);
  }
  if (!ready) throw new Error("The dedicated SQL Server did not become ready within the startup timeout.");
  const env = { ...process.env, QUERVIO_TEST_SERVER: `tcp:127.0.0.1,${port}`,
    QUERVIO_TEST_USER: "sa", QUERVIO_TEST_PASSWORD: password,
    QUERVIO_TEST_EXPECTED_MAJOR: majors[values.version], QUERVIO_TEST_REPORT: path.join(reportDir, "server.json") };
  await run("cargo", ["test", "--locked", "-p", "quervio-core",
    "--test", "compatibility", "--test", "driver", "--test", "catalog", "--test", "execution", "--test", "management",
    // This Windows-only check deliberately targets the PC's default instance,
    // not QUERVIO_TEST_SERVER. Keep this runner exclusively on its container.
    "--", "--ignored", "--skip", "bare_localhost_without_a_local_instance_explains_itself"], { env });
  report.status = "passed";
} catch (error) {
  // Do not print raw subprocess errors: diagnostic output must never disclose
  // the generated password, even when a downstream tool echoes its environment.
  console.error(String(error).replaceAll(password, "[redacted]"));
  process.exitCode = 1;
} finally {
  if (created) {
    try {
      await run("docker", ["rm", "--force", name], { capture: true });
    } catch {
      console.error(`Could not remove dedicated test container ${name}.`);
      process.exitCode = 1;
      report.status = "failed";
    }
  }
  await mkdir(reportDir, { recursive: true });
  try { report.server = JSON.parse(await readFile(path.join(reportDir, "server.json"), "utf8")); } catch { /* Probe may not have run. */ }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(reportDir, "run.json"), JSON.stringify(report, null, 2));
  console.log(`Compatibility report: ${path.relative(root, path.join(reportDir, "run.json"))}`);
}
