"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const fsSync = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const { loadConfig } = require("./config");
const windows = process.platform === "win32";
// PowerShell startup plus two loopback probes is normally ~2 s; the margin covers
// cold CI images. A hung child is reported with its captured output, not silently.
const LAUNCHER_TIMEOUT_MS = 60000;
function isolatedChildEnv() {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "PSModulePath", "ProgramFiles", "ProgramFiles(x86)"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
// Child output goes to a file rather than a pipe: the Windows sandbox forbids piped
// stdio, and a file keeps a failure diagnosable. Timeout kills the whole tree so a
// stalled PowerShell (or the node it started) cannot outlive the test.
function runLauncher(file, checkOnly, options = {}) {
  return new Promise((resolve, reject) => {
    const logFile = path.join(os.tmpdir(), `bridge-launcher-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
    const outFd = fsSync.openSync(logFile, "w");
    const target = path.join(__dirname, "start-bridge.ps1");
    const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", target,
      "-NodePath", options.nodePath ?? process.execPath, "-EnvFile", file, ...(checkOnly ? ["-CheckOnly"] : [])];
    let child;
    try {
      child = spawn("powershell.exe", args, { env: isolatedChildEnv(), cwd: options.cwd, stdio: ["ignore", outFd, outFd] });
    } catch (error) { fsSync.closeSync(outFd); reject(error); return; }
    const readOutput = () => {
      try { return fsSync.readFileSync(logFile, "utf8").slice(-2000); } catch { return ""; }
    };
    const cleanup = () => {
      try { fsSync.closeSync(outFd); } catch {}
      try { fsSync.rmSync(logFile, { force: true }); } catch {}
    };
    const timer = setTimeout(() => {
      try { spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
      try { child.kill(); } catch {}
      const output = readOutput(); cleanup();
      reject(new Error(`Isolated launcher test timed out after ${LAUNCHER_TIMEOUT_MS} ms (pid ${child.pid}). Output: ${output || "<none>"}`));
    }, LAUNCHER_TIMEOUT_MS);
    child.once("error", error => { clearTimeout(timer); cleanup(); reject(error); });
    child.once("exit", code => { clearTimeout(timer); cleanup(); resolve(code); });
  });
}
async function fixture(t, port = 8787) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge launcher fixture "));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, "isolated config.env");
  await fs.writeFile(file, `AZURE_OPENAI_BASE=https://example.invalid\nBRIDGE_APPROVED_ORIGINS='["https://example.invalid"]'\nAZURE_OPENAI_API_KEY=fixture-upstream\nBRIDGE_PROXY_TOKEN=fixture-local\nAZURE_OPENAI_MODEL=deployment\nAZURE_OPENAI_VARIANT=gpt-6-luna\nAZURE_OPENAI_VERSION=fixture\nBRIDGE_MODEL_ALIAS=local\nexport BRIDGE_PORT=" ${port} "\n`);
  return file;
}
async function probe(t, responder) {
  const server = http.createServer(responder);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}
test("launcher loopback probes use basic parsing and skip proxy auto-detection", () => {
  // Regression guard: without -UseBasicParsing, Windows PowerShell 5.1 uses the IE
  // DOM parser, which stalls on clean CI images during IE first-run configuration.
  const source = fsSync.readFileSync(path.join(__dirname, "start-bridge.ps1"), "utf8");
  const calls = source.match(/Invoke-RestMethod[^\n]*/g) || [];
  assert.equal(calls.length, 2, "expected exactly two loopback probes");
  for (const call of calls) assert.match(call, /-UseBasicParsing/);
  assert.match(source, /DefaultWebProxy/);
  assert.match(source, /-TimeoutSec 2/);
});

test("Windows launcher uses the shared parser and explicit Node path with spaced fixture paths", { skip: !windows, timeout: 120000 }, async t => {
  const file = await fixture(t);
  assert.equal(await runLauncher(file, true), 0);
  await fs.appendFile(file, "\nBRIDGE_PORT=8787oops\n");
  assert.notEqual(await runLauncher(file, true), 0);
});
test("Windows launcher rejects same-port impostors and older builds instead of starting/replacing them", { skip: !windows, timeout: 120000 }, async t => {
  let requests = 0, reply;
  const port = await probe(t, (_req, res) => { requests++; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(reply)); });
  const file = await fixture(t, port);
  const config = loadConfig({ env: {}, envFile: file });
  for (reply of [{ status: "ok" }, { status: "ok", service: "azure-responses-bridge", protocol: "chat-to-responses-v1", build: "adapter-v2", configId: config.configId }]) {
    requests = 0; assert.notEqual(await runLauncher(file, false), 0);
    assert.equal(requests, 1);
  }
});
test("Windows launcher resolves relative executable and env paths before its cwd shift", { skip: !windows, timeout: 120000 }, async t => {
  const port = await probe(t, (_req, res) => { res.statusCode = 404; res.end(); });
  const summary = JSON.stringify({ service: "azure-responses-bridge", protocol: "chat-to-responses-v1", build: "adapter-v2.9", configId: "fixture", host: "127.0.0.1", port });
  const psQuote = value => value.replace(/'/g, "''");
  for (const lowercaseDrive of [false, true]) {
    const fixtureFile = await fixture(t, port);
    // Hosted Windows TEMP paths can use a lowercase drive letter; Resolve-Path
    // normalizes it. Exercise that spelling even when the local TEMP does not.
    const file = lowercaseDrive ? fixtureFile.replace(/^[A-Z]:/i, drive => drive.toLowerCase()) : fixtureFile;
    const temp = path.dirname(file);
    const shim = path.join(temp, "fixture node.ps1"); const captured = path.join(temp, "runtime args.json");
    // This version-reporting fixture records launch arguments instead of running a bridge.
    await fs.writeFile(shim, `$global:LASTEXITCODE=0\nif ($args -contains '--version') { 'v24.20.0'; return }\nif ($args -contains '--check-config-json') { '${psQuote(summary)}'; return }\nConvertTo-Json -InputObject @($args) -Compress | Set-Content -LiteralPath '${psQuote(captured)}' -Encoding UTF8\n`);
    assert.equal(await runLauncher('.\\' + path.basename(file), false, { nodePath: '.\\' + path.basename(shim), cwd: temp }), 0);
    const args = JSON.parse((await fs.readFile(captured, "utf8")).replace(/^\uFEFF/, ""));
    assert.equal(args.filter(arg => arg === "--env-file").length, 1);
    const resolvedEnvFile = args[args.indexOf("--env-file") + 1];
    assert.equal(path.isAbsolute(resolvedEnvFile), true, "runtime env path must be absolute after the cwd shift");
    // Compare the actual file, not path spelling (drive case and 8.3 aliases
    // may differ between Node's TEMP and PowerShell's filesystem provider).
    assert.equal(await fs.realpath(resolvedEnvFile), await fs.realpath(file));
  }
});
test("Windows launcher recognizes matching identity and checks readiness without restarting", { skip: !windows, timeout: 120000 }, async t => {
  const paths = []; let summary;
  const port = await probe(t, (req, res) => { paths.push(req.url); res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ...summary, status: req.url === "/readyz" ? "ready" : "ok" })); });
  const file = await fixture(t, port);
  const config = loadConfig({ env: {}, envFile: file });
  summary = { service: "azure-responses-bridge", protocol: "chat-to-responses-v1", build: "adapter-v2.9", configId: config.configId };
  assert.equal(await runLauncher(file, false), 0);
  assert.deepEqual(paths, ["/healthz", "/readyz"]);
});
