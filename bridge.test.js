"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const http = require("node:http");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");

const bridgePath = path.join(__dirname, "bridge.js");
const proxyToken = "test-proxy-token";
let bridge;
let bridgePort;
let upstream;
let upstreamPort;
let lastUpstreamRequest;
let startupLog;

async function listenOnEphemeralPort(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return server.address().port;
}

before(async () => {
  upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const _chunk of req) {
      chunks.push(_chunk);
    }
    lastUpstreamRequest = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end([
      'event: response.created\ndata: {"response":{"id":"resp_test","created_at":123,"model":"azure-response-model"}}\n\n',
      'event: response.refusal.delta\ndata: {"delta":"Refusal text"}\n\n',
      'event: response.completed\ndata: {"response":{"status":"completed","usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}}\n\n',
    ].join(""));
  });
  upstreamPort = await listenOnEphemeralPort(upstream);

  const portProbe = http.createServer();
  bridgePort = await listenOnEphemeralPort(portProbe);
  await new Promise((resolve) => portProbe.close(resolve));

  bridge = spawn(process.execPath, [bridgePath], {
    cwd: __dirname,
    env: {
      ...process.env,
      BRIDGE_PORT: String(bridgePort),
      BRIDGE_PROXY_TOKEN: proxyToken,
      AZURE_OPENAI_API_KEY: "test-azure-key",
      AZURE_OPENAI_BASE: `http://127.0.0.1:${upstreamPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let startupOutput = "";
  const started = new Promise((resolve, reject) => {
    bridge.stdout.on("data", (chunk) => {
      startupOutput += chunk.toString();
      const listeningLine = startupOutput.split("\n").find((line) => line.includes('"event":"listening"'));
      if (listeningLine) {
        startupLog = JSON.parse(listeningLine);
        resolve();
      }
    });
    bridge.stderr.on("data", (chunk) => {
      startupOutput += chunk.toString();
    });
    bridge.once("error", reject);
    bridge.once("exit", (code) => {
      reject(new Error(`Bridge exited before startup (${code}): ${startupOutput}`));
    });
  });
  await started;
});

after(async () => {
  if (bridge && bridge.exitCode === null) {
    const exited = once(bridge, "exit");
    bridge.kill();
    await exited;
  }
  if (upstream) await new Promise((resolve) => upstream.close(resolve));
});

async function postCompletion(body) {
  return fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${proxyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

test("log timestamps use the local system timezone", () => {
  const loggedDate = new Date(startupLog.time);
  const offsetMinutes = -loggedDate.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  assert.ok(startupLog.time.endsWith(`${sign}${offsetHours}:${offsetRemainder}`));
});

test("stream includes refusal text and reports the upstream model", async () => {
  const response = await postCompletion({
    model: "requested-model",
    messages: [{ role: "user", content: "hello" }],
    stream: true,
  });
  assert.equal(response.status, 200);

  const body = await response.text();
  const frames = [...body.matchAll(/^data: (.+)$/gm)].map((match) => match[1]);
  const chunks = frames.filter((frame) => frame !== "[DONE]").map((frame) => JSON.parse(frame));
  assert.equal(frames.filter((frame) => frame === "[DONE]").length, 1);
  assert.equal(chunks[0].model, "azure-response-model");
  assert.ok(chunks.some((chunk) => chunk.choices[0]?.delta?.content === "Refusal text"));
});

test("oversized request receives a 413 response", async () => {
  const response = await postCompletion({
    messages: [{ role: "user", content: "x".repeat(1024 * 1024) }],
  });
  assert.equal(response.status, 413);
  assert.match((await response.json()).error.message, /exceeds 1 MiB/);
});

test("unsupported message content is rejected instead of dropped", async () => {
  const response = await postCompletion({
    messages: [{ role: "user", content: [{ type: "input_audio", data: "payload" }] }],
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /Unsupported message content type/);
});

test("reasoning requests encode assistant history as output_text", async () => {
  const response = await postCompletion({
    model: "gpt-6-luna",
    reasoning_effort: "low",
    stream: true,
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Follow-up" },
    ],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(lastUpstreamRequest.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(lastUpstreamRequest.input, [
    { role: "user", content: [{ type: "input_text", text: "First question" }] },
    { role: "assistant", content: [{ type: "output_text", text: "Earlier answer" }] },
    { role: "user", content: [{ type: "input_text", text: "Follow-up" }] },
  ]);
});