"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

const bridgePath = path.join(__dirname, "bridge.js");

async function unusedPort(host) {
  const probe = http.createServer();
  probe.listen(0, host);
  await once(probe, "listening");
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function launch(overrides) {
  const child = spawn(process.execPath, [bridgePath], {
    cwd: __dirname,
    env: {
      ...process.env,
      // Explicit values override any local .env without using live credentials.
      AZURE_OPENAI_BASE: "http://127.0.0.1:9",
      AZURE_OPENAI_API_KEY: "mock-azure-key",
      BRIDGE_PROXY_TOKEN: "mock-proxy-token",
      AZURE_OPENAI_MODEL: "mock-model",
      BRIDGE_TLS_CERT: "",
      BRIDGE_TLS_KEY: "",
      BRIDGE_LOG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (data) => { output += data.toString(); });
  child.stderr.on("data", (data) => { output += data.toString(); });
  return { child, output: () => output };
}

test("LAN listener uses configured host and rejects missing credentials", { skip: process.platform !== "linux" }, async () => {
  const host = "127.0.0.2"; // Linux loopback alias; no dependency on a particular LAN IP.
  const port = await unusedPort(host);
  const { child, output } = launch({ BRIDGE_HOST: host, BRIDGE_PORT: String(port) });
  try {
    const started = new Promise((resolve, reject) => {
      let lines = "";
      child.stdout.on("data", (data) => {
        lines += data;
        if (lines.includes('"event":"listening"')) resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`Bridge exited (${code}): ${output()}`)));
    });
    await started;
    const response = await fetch(`http://${host}:${port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
    // Binding a specific address must not also expose the port on another address.
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  } finally {
    if (child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }

  const missing = launch({ BRIDGE_HOST: host, BRIDGE_PORT: String(port), BRIDGE_PROXY_TOKEN: "" });
  const [code] = await once(missing.child, "exit");
  assert.notEqual(code, 0);
  assert.match(missing.output(), /LAN mode requires BRIDGE_PROXY_TOKEN/);
});
