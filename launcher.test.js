"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { loadConfig } = require("./config");
const windows = process.platform === "win32";
function isolatedChildEnv() {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "PSModulePath", "ProgramFiles", "ProgramFiles(x86)"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}
function runLauncher(file, checkOnly, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(__dirname, "start-bridge.ps1"), "-NodePath", options.nodePath ?? process.execPath, "-EnvFile", file, ...(checkOnly ? ["-CheckOnly"] : [])],
    { env: isolatedChildEnv(), cwd: options.cwd, stdio: "ignore" }); // No captured child pipes in the Windows sandbox.
    const timer = setTimeout(() => { child.kill(); reject(new Error("Isolated launcher test timed out")); }, 20000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
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
test("Windows launcher uses the shared parser and explicit Node path with spaced fixture paths", { skip: !windows, timeout: 25000 }, async t => {
  const file = await fixture(t);
  assert.equal(await runLauncher(file, true), 0);
  await fs.appendFile(file, "\nBRIDGE_PORT=8787oops\n");
  assert.notEqual(await runLauncher(file, true), 0);
});
test("Windows launcher rejects same-port impostors and older builds instead of starting/replacing them", { skip: !windows, timeout: 25000 }, async t => {
  let requests = 0, reply;
  const port = await probe(t, (_req, res) => { requests++; res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(reply)); });
  const file = await fixture(t, port);
  const config = loadConfig({ env: {}, envFile: file });
  for (reply of [{ status: "ok" }, { status: "ok", service: "azure-responses-bridge", protocol: "chat-to-responses-v1", build: "adapter-v2", configId: config.configId }]) {
    requests = 0; assert.notEqual(await runLauncher(file, false), 0);
    assert.equal(requests, 1);
  }
});
test("Windows launcher resolves relative executable and env paths before its cwd shift", { skip: !windows, timeout: 25000 }, async t => {
  const port = await probe(t, (_req, res) => { res.statusCode = 404; res.end(); });
  const file = await fixture(t, port); const temp = path.dirname(file);
  const shim = path.join(temp, "fixture node.ps1"); const captured = path.join(temp, "runtime args.json");
  const summary = JSON.stringify({ service: "azure-responses-bridge", protocol: "chat-to-responses-v1", build: "adapter-v2.9", configId: "fixture", host: "127.0.0.1", port });
  const psQuote = value => value.replace(/'/g, "''");
  // This version-reporting fixture records launch arguments instead of running a bridge.
  await fs.writeFile(shim, `$global:LASTEXITCODE=0\nif ($args -contains '--version') { 'v24.20.0'; return }\nif ($args -contains '--check-config-json') { '${psQuote(summary)}'; return }\nConvertTo-Json -InputObject @($args) -Compress | Set-Content -LiteralPath '${psQuote(captured)}' -Encoding UTF8\n`);
  assert.equal(await runLauncher('.\\' + path.basename(file), false, { nodePath: '.\\' + path.basename(shim), cwd: temp }), 0);
  const args = JSON.parse((await fs.readFile(captured, "utf8")).replace(/^\uFEFF/, ""));
  assert.equal(args[args.indexOf("--env-file") + 1], file);
});
test("Windows launcher recognizes matching identity and checks readiness without restarting", { skip: !windows, timeout: 25000 }, async t => {
  const paths = []; let summary;
  const port = await probe(t, (req, res) => { paths.push(req.url); res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ...summary, status: req.url === "/readyz" ? "ready" : "ok" })); });
  const file = await fixture(t, port);
  const config = loadConfig({ env: {}, envFile: file });
  summary = { service: "azure-responses-bridge", protocol: "chat-to-responses-v1", build: "adapter-v2.9", configId: config.configId };
  assert.equal(await runLauncher(file, false), 0);
  assert.deepEqual(paths, ["/healthz", "/readyz"]);
});
