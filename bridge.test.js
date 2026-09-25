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
let upstreamResponder;

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
    if (upstreamResponder) {
      upstreamResponder(req, res);
      return;
    }
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
      BRIDGE_HOST: "127.0.0.1",
      BRIDGE_TLS_CERT: "",
      BRIDGE_TLS_KEY: "",
      BRIDGE_LOG_PATH: process.platform === "win32" ? "NUL" : "/dev/null",
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

async function postCompletion(body, options = {}) {
  return fetch(`http://127.0.0.1:${bridgePort}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.token ?? proxyToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: options.signal,
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

test("rejects invalid proxy tokens before forwarding upstream", async () => {
  let forwarded = false;
  upstreamResponder = () => { forwarded = true; };
  try {
    const response = await postCompletion({ messages: [{ role: "user", content: "hi" }] }, { token: "wrong" });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.type, "authentication_error");
    assert.equal(forwarded, false);
  } finally {
    upstreamResponder = undefined;
  }
});

test("maps a non-streaming Azure response and usage", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "resp_json", created_at: 123, model: "deployment", status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
      usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 },
    }));
  };
  try {
    const response = await postCompletion({ messages: [{ role: "user", content: "hi" }], stream: false });
    assert.equal(response.status, 200);
    assert.equal(lastUpstreamRequest.stream, false);
    const result = await response.json();
    assert.equal(result.id, "chatcmpl-resp_json");
    assert.equal(result.choices[0].message.content, "Hello");
    assert.equal(result.choices[0].finish_reason, "stop");
    assert.deepEqual(result.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  } finally {
    upstreamResponder = undefined;
  }
});

test("maps a tool-call round trip and returned tool call", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      id: "resp_tool", status: "completed",
      output: [{ type: "function_call", call_id: "call_2", name: "lookup", arguments: '{"key":"b"}' }],
    }));
  };
  try {
    const response = await postCompletion({
      messages: [
        { role: "user", content: "Look up two keys" },
        { role: "assistant", content: null, tool_calls: [
          { type: "function", id: "call_1", function: { name: "lookup", arguments: '{"key":"a"}' } },
        ] },
        { role: "tool", tool_call_id: "call_1", content: '{"value":1}' },
      ],
      tools: [{ type: "function", function: { name: "lookup", description: "Lookup key", parameters: { type: "object" } } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(lastUpstreamRequest.input.slice(1), [
      { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"key":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: '{"value":1}' },
    ]);
    assert.deepEqual(lastUpstreamRequest.tool_choice, { type: "function", name: "lookup" });
    assert.equal(lastUpstreamRequest.tools[0].name, "lookup");
    const result = await response.json();
    assert.equal(result.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(result.choices[0].message.tool_calls, [
      { id: "call_2", type: "function", function: { name: "lookup", arguments: '{"key":"b"}' } },
    ]);
  } finally {
    upstreamResponder = undefined;
  }
});

test("preserves upstream error status and message", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(429, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Rate limited", type: "rate_limit_error", code: "slow_down" } }));
  };
  try {
    const response = await postCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), {
      error: { message: "Rate limited", type: "rate_limit_error", code: "slow_down" },
    });
  } finally {
    upstreamResponder = undefined;
  }
});

test("converts an Azure response.failed body into a gateway error", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "failed", error: { message: "Deployment unavailable", type: "server_error", code: "offline" },
    }));
  };
  try {
    const response = await postCompletion({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      error: { message: "Deployment unavailable", type: "server_error", code: "offline" },
    });
  } finally {
    upstreamResponder = undefined;
  }
});

test("maps streaming upstream failures to an error frame and DONE", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('event: response.failed\ndata: {"response":{"error":{"message":"Upstream failed","code":"offline"}}}\n\n');
  };
  try {
    const response = await postCompletion({ stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.status, 200);
    const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => match[1]);
    assert.equal(frames.at(-1), "[DONE]");
    assert.equal(JSON.parse(frames.at(-2)).error.message, "Upstream failed");
  } finally {
    upstreamResponder = undefined;
  }
});

test("streaming tool-call deltas retain ID, name, arguments and finish reason", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const [name, payload] of [
      ["response.output_item.added", { output_index: 0, item: { type: "function_call", call_id: "call_3", name: "lookup" } }],
      ["response.function_call_arguments.delta", { output_index: 0, delta: '{"key":' }],
      ["response.function_call_arguments.delta", { output_index: 0, delta: '"c"}' }],
      ["response.completed", { response: { status: "completed" } }],
    ]) res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    res.end();
  };
  try {
    const response = await postCompletion({ stream: true, messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.status, 200);
    const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => match[1]);
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames.slice(0, -1).map(JSON.parse);
    const toolDeltas = chunks.flatMap((chunk) => chunk.choices[0]?.delta?.tool_calls || []);
    assert.equal(toolDeltas[0].id, "call_3");
    assert.equal(toolDeltas[0].function.name, "lookup");
    assert.equal(toolDeltas.map((delta) => delta.function.arguments).join(""), '{"key":"c"}');
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  } finally {
    upstreamResponder = undefined;
  }
});

test("aborts an oversized unfinished SSE line without waiting for upstream EOF", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: response.output_text.delta\ndata: " + "x".repeat(1024 * 1024 + 1));
    // Deliberately leave the upstream stream open and omit the newline.
  };
  try {
    const response = await postCompletion(
      { stream: true, messages: [{ role: "user", content: "hi" }] },
      { signal: AbortSignal.timeout(3000) },
    );
    assert.equal(response.status, 200);
    const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => match[1]);
    assert.equal(frames.at(-1), "[DONE]");
    assert.match(JSON.parse(frames.at(-2)).error.message, /SSE.*exceeds.*1 MiB/);
  } finally {
    upstreamResponder = undefined;
  }
});

test("aborts an oversized multiline SSE event", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("event: response.output_text.delta\n");
    for (let i = 0; i < 16; i++) res.write(`data: ${"x".repeat(70 * 1024)}\n`);
    // The individual lines are small; together they exceed the event cap.
  };
  try {
    const response = await postCompletion(
      { stream: true, messages: [{ role: "user", content: "hi" }] },
      { signal: AbortSignal.timeout(3000) },
    );
    const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => match[1]);
    assert.equal(frames.at(-1), "[DONE]");
    assert.match(JSON.parse(frames.at(-2)).error.message, /SSE.*exceeds.*1 MiB/);
  } finally {
    upstreamResponder = undefined;
  }
});

test("does not accumulate the event limit across separate SSE frames", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    for (let i = 0; i < 12; i++) {
      res.write(`event: response.output_text.delta\ndata: ${JSON.stringify({ delta: "x".repeat(96 * 1024) })}\n\n`);
    }
    res.end('event: response.completed\ndata: {"response":{"status":"completed"}}\n\n');
  };
  try {
    const response = await postCompletion({ stream: true, messages: [{ role: "user", content: "hi" }] });
    const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => match[1]);
    assert.equal(frames.at(-1), "[DONE]");
    const chunks = frames.slice(0, -1).map(JSON.parse);
    assert.equal(chunks.filter((frame) => frame.choices[0]?.delta?.content).length, 12);
    assert.equal(chunks.at(-1).choices[0].finish_reason, "stop");
  } finally {
    upstreamResponder = undefined;
  }
});

test("limits multibyte SSE data by bytes and accepts a normal follow-up request", async () => {
  upstreamResponder = (_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write("data: " + "é".repeat(600 * 1024));
  };
  try {
    const response = await postCompletion(
      { stream: true, messages: [{ role: "user", content: "hi" }] },
      { signal: AbortSignal.timeout(3000) },
    );
    const frames = [...(await response.text()).matchAll(/^data: (.+)$/gm)].map((match) => match[1]);
    assert.equal(frames.at(-1), "[DONE]");
    assert.match(JSON.parse(frames.at(-2)).error.message, /SSE.*exceeds.*1 MiB/);
  } finally {
    upstreamResponder = undefined;
  }
  const response = await postCompletion({ stream: true, messages: [{ role: "user", content: "ok" }] });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /data: \[DONE\]/);
});
