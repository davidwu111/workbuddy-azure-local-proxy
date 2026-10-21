"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { once } = require("node:events");
const http = require("node:http");
const https = require("node:https");
const net = require("node:net");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn, spawnSync } = require("node:child_process");
const { createBridgeServer, validateListenerTls, BUILD } = require("./server");
const { validateConfig } = require("./config");
const linux = process.platform === "linux";
const tlsCert = path.join(__dirname, "test-fixtures/tls/localhost-cert.pem");
const tlsKey = path.join(__dirname, "test-fixtures/tls/localhost-key.pem");
const token = "fixture-local";
const raw = overrides => ({ azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"],
  azureApiKey: "fixture-upstream", proxyToken: token, defaultModel: "local",
  models: { local: { deployment: "fixture", variant: "gpt-6-luna", version: "fixture" } },
  logMode: "console", timeouts: { shutdownMs: 100 }, ...overrides });
const completed = { id: "resp_fixture", status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: "fixture answer" }] }] };
async function listener(t, overrides, fetchImpl) {
  const config = validateConfig(raw(overrides));
  const server = createBridgeServer(config, { fetchImpl });
  t.after(() => server.shutdown());
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, config.host, resolve); });
  return server;
}
function tlsRequest(port, route, { body, authorization, ca = fs.readFileSync(tlsCert) } = {}) {
  return new Promise((resolve, reject) => {
    const encoded = body === undefined ? undefined : JSON.stringify(body);
    const req = https.request({ hostname: "127.0.0.1", port, path: route, method: encoded ? "POST" : "GET", ca, agent: false,
      headers: { ...(encoded ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(encoded) } : {}),
        ...(authorization ? { Authorization: authorization } : {}) } }, res => {
      const chunks = []; res.on("data", chunk => chunks.push(chunk)); res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(3000, () => req.destroy(new Error("Fixture TLS request timed out")));
    req.on("error", reject); req.end(encoded);
  });
}
test("native HTTPS shares health, readiness, aliases, authentication and Chat/SSE handling", { timeout: 10000 }, async t => {
  let calls = 0;
  const server = await listener(t, { tlsCert, tlsKey }, (_url, options) => {
    calls++; const request = JSON.parse(options.body);
    assert.equal(options.redirect, "error"); assert.equal(request.model, "fixture");
    return request.stream ? new Response(`event: response.completed\ndata: ${JSON.stringify({ response: completed })}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } }) : new Response(JSON.stringify(completed), { headers: { "Content-Type": "application/json" } });
  });
  const port = server.address().port;
  for (const route of ["/healthz", "/readyz", "/v1/models"]) {
    const response = await tlsRequest(port, route); assert.equal(response.status, 200);
    const payload = JSON.parse(response.text);
    if (route === "/v1/models") assert.deepEqual(payload.data.map(x => x.id), ["local"]);
    else { assert.equal(payload.build, BUILD); assert.equal(payload.status, route === "/readyz" ? "ready" : "ok"); }
  }
  assert.equal(calls, 0);
  const body = { messages: [{ role: "user", content: "fixture" }] };
  assert.equal((await tlsRequest(port, "/v1/chat/completions", { body })).status, 401);
  assert.equal(calls, 0);
  const response = await tlsRequest(port, "/v1/chat/completions", { body, authorization: `Bearer ${token}` });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.text).choices[0].message.content, "fixture answer");
  const stream = await tlsRequest(port, "/v1/chat/completions", { body: { ...body, stream: true }, authorization: `Bearer ${token}` });
  assert.equal(stream.status, 200); assert.equal((stream.text.match(/data: \[DONE\]/g) || []).length, 1);
  assert.equal(calls, 2);
  await assert.rejects(tlsRequest(port, "/healthz", { ca: [] }), /self-signed|certificate/i);
});
test("TLS validation rejects missing, invalid and mismatched pairs without exposing paths or contents", async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "bridge tls invalid "));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const invalid = path.join(temp, "PRIVATE_PATH_MARKER.pem"); await fsp.writeFile(invalid, "PRIVATE_CONTENT_MARKER");
  const oversized = path.join(temp, "oversized.pem"); await fsp.writeFile(oversized, Buffer.alloc(1024 * 1024 + 1));
  const cases = [{ tlsCert: invalid, tlsKey }, { tlsCert, tlsKey: invalid }, { tlsCert: path.join(temp, "absent"), tlsKey },
    { tlsCert, tlsKey: path.join(__dirname, "test-fixtures/tls/unrelated-key.pem") }, { tlsCert: temp, tlsKey }, { tlsCert: oversized, tlsKey }];
  if (linux) {
    cases.push({ tlsCert: "/dev/null", tlsKey });
    const fifo = path.join(temp, "fifo.pem");
    const made = spawnSync("mkfifo", [fifo], { stdio: "ignore", timeout: 1000 });
    assert.ifError(made.error); assert.equal(made.status, 0);
    cases.push({ tlsCert: fifo, tlsKey });
  }
  for (const overrides of cases) {
    assert.throws(() => createBridgeServer(raw(overrides)), error => {
      assert.equal(error.code, "INVALID_CONFIG"); assert.equal(error.param, "tls");
      assert.equal(error.message.includes("PRIVATE"), false); return true;
    });
  }
  assert.equal(validateListenerTls(validateConfig(raw())), undefined);
});
test("HTTPS shutdown bounds sockets that have not completed a TLS handshake", { timeout: 5000 }, async t => {
  const server = await listener(t, { tlsCert, tlsKey }, () => { throw new Error("No upstream call expected"); });
  const socket = net.connect(server.address().port, "127.0.0.1"); socket.on("error", () => {});
  t.after(() => socket.destroy()); await once(socket, "connect");
  const closed = once(socket, "close");
  await server.shutdown(); await closed; assert.equal(server.listening, false);
});
test("Linux binds only the configured loopback alias, never a sibling address", { skip: !linux, timeout: 5000 }, async t => {
  const server = await listener(t, { host: "127.0.0.2" }, () => { throw new Error("No upstream call expected"); });
  const port = server.address().port;
  assert.equal((await fetch(`http://127.0.0.2:${port}/readyz`, { signal: AbortSignal.timeout(1000) })).status, 200);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }));
});
function childEnv(overrides = {}) {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "PATH", "Path", "PATHEXT", "TEMP", "TMP", "HOME"]) if (process.env[name] !== undefined) env[name] = process.env[name];
  return { ...env, AZURE_OPENAI_BASE: "https://example.invalid", BRIDGE_APPROVED_ORIGINS: '["https://example.invalid"]',
    AZURE_OPENAI_API_KEY: "fixture-upstream", BRIDGE_PROXY_TOKEN: token, AZURE_OPENAI_MODEL: "fixture",
    AZURE_OPENAI_VARIANT: "gpt-6-luna", AZURE_OPENAI_VERSION: "fixture", BRIDGE_MODEL_ALIAS: "local", BRIDGE_LOG_MODE: "console", ...overrides };
}
test("real CLI check uses isolated environment and exposes transport without creating logs", async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "bridge check fixture "));
  t.after(() => fsp.rm(temp, { recursive: true, force: true }));
  const output = path.join(temp, "output.txt"); const fd = fs.openSync(output, "w");
  let child;
  try { child = spawnSync(process.execPath, [path.join(__dirname, "bridge.js"), "--no-env-file", "--check-config-json"],
    { cwd: temp, env: childEnv({ BRIDGE_TLS_CERT: tlsCert, BRIDGE_TLS_KEY: tlsKey, BRIDGE_LOG_PATH: path.join(temp, "fixture.log") }), stdio: ["ignore", fd, fd], timeout: 5000 }); }
  finally { fs.closeSync(fd); }
  assert.ifError(child.error); assert.equal(child.status, 0);
  const summary = JSON.parse(await fsp.readFile(output, "utf8")); assert.equal(summary.transport, "https"); assert.equal(summary.build, BUILD);
  assert.deepEqual(await fsp.readdir(temp), ["output.txt"]);
});
for (const signal of ["SIGINT", "SIGTERM"]) test(`Linux foreground CLI handles ${signal} and releases its listener`, { skip: !linux, timeout: 10000 }, async t => {
  const temp = await fsp.mkdtemp(path.join(os.tmpdir(), "bridge signal fixture "));
  const probe = http.createServer(); await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const output = path.join(temp, "output.txt"); const fd = fs.openSync(output, "w");
  let child, exited, guard;
  t.after(async () => {
    clearTimeout(guard);
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited?.catch(() => {});
    } finally { fs.closeSync(fd); await fsp.rm(temp, { recursive: true, force: true }); }
  });
  child = spawn(process.execPath, [path.join(__dirname, "bridge.js"), "--no-env-file"],
    { cwd: temp, env: childEnv({ BRIDGE_PORT: String(port), BRIDGE_TIMEOUTS: '{"shutdownMs":100}', BRIDGE_LOG_PATH: path.join(temp, "fixture.log") }), stdio: ["ignore", fd, fd] });
  exited = new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code, sig) => resolve({ code, sig })); });
  // A failing signal regression must not strand the fixture child or cleanup.
  guard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 7000);
  exited.then(() => clearTimeout(guard), () => clearTimeout(guard));
  const started = Date.now(); let ready = false;
  while (Date.now() - started < 5000 && child.exitCode === null && child.signalCode === null) {
    try { ready = (await fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(100) })).status === 200; } catch {}
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(ready, true, await fsp.readFile(output, "utf8"));
  // Leave a real upload in progress: graceful close must abort it within the
  // configured grace period rather than waiting for the default upload timeout.
  const upload = net.connect(port, "127.0.0.1"); upload.on("error", () => {});
  t.after(() => upload.destroy()); await once(upload, "connect");
  upload.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: 999\r\n\r\n{`);
  await new Promise(resolve => setTimeout(resolve, 50));
  child.kill(signal); child.kill(signal);
  const result = await exited; assert.deepEqual(result, { code: 0, sig: null });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/readyz`, { signal: AbortSignal.timeout(500) }));
  const log = await fsp.readFile(output, "utf8");
  assert.equal((log.match(/"event":"shutdown"/g) || []).length, 1);
  assert.deepEqual(await fsp.readdir(temp), ["output.txt"], "console mode must not create the isolated log sentinel");
});
