"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const http = require("node:http");
const { once } = require("node:events");
const { createBridgeServer, SERVICE, PROTOCOL, BUILD } = require("./server");
const { createLogger } = require("./logger");

const LOCAL_TOKEN = "fixture-local-token", UPSTREAM_KEY = "fixture-upstream-key";
const body = extras => ({ messages: [{ role: "user", content: "hello" }], ...extras });
const completed = extras => ({ id: "resp_fixture", created_at: 123, status: "completed", output: [{ type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "hello" }] }], ...extras });
const functionCall = extras => ({ type: "function_call", id: "item_1", status: "completed", call_id: "call_1", name: "lookup", arguments: '{"key":"a"}', ...extras });
const functionTools = [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }];
const event = (name, payload, ending = "\n", typed = false) => `${typed ? "" : `event: ${name}${ending}`}data: ${JSON.stringify({ ...(typed ? { type: name } : {}), ...payload })}${ending}${ending}`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function json(value, { status = 200, headers = {} } = {}) { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } }); }
function stream(text, { step = 4093, headers = {} } = {}) {
  const bytes = Buffer.from(text);
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += step) controller.enqueue(bytes.subarray(i, i + step)); controller.close(); } }), { headers: { "Content-Type": "text/event-stream", ...headers } });
}
function trackedBody(read) {
  const stats = { read: 0, cancel: 0, release: 0, bodyCancel: 0 };
  return { stats, body: { cancel() { stats.bodyCancel++; return Promise.resolve(); }, getReader() { return { read() { stats.read++; return read(stats.read); }, cancel() { stats.cancel++; return Promise.resolve(); }, releaseLock() { stats.release++; } }; } } };
}
function upstreamWithBody(value, mime = "application/json", status = 200) { return { status, headers: new Headers({ "Content-Type": mime }), body: value }; }
async function fixture(t, fetchImpl, overrides = {}) {
  const logs = []; const server = createBridgeServer({ azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"], azureApiKey: UPSTREAM_KEY, proxyToken: LOCAL_TOKEN,
    defaultModel: "local", models: { local: { deployment: "fixture-deployment", variant: "gpt-6-luna", version: "fixture-version" } },
    timeouts: { upstreamIdleMs: 1000, uploadMs: 1000, totalMs: 5000, downstreamStallMs: 100, shutdownMs: 100, ...(overrides.timeouts || {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "timeouts")),
  }, { fetchImpl, logger: (name, value) => logs.push({ name, ...value }) });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, logs, base, post: (value = body(), options = {}) => fetch(base + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, "Content-Type": "application/json", ...options.headers }, body: options.raw ?? JSON.stringify(value), signal: options.signal ?? AbortSignal.timeout(4000) }) };
}
function frames(text) { return text.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)); }
function parsedFrames(text) { return frames(text).filter(value => value !== "[DONE]").map(value => JSON.parse(value)); }
function toolFrames(text) { return parsedFrames(text).flatMap(value => value.choices?.flatMap(choice => choice.delta?.tool_calls || []) || []); }

// Every upstream is injected; network use is owned ephemeral loopback only.
test("factory is explicit, defaults to loopback, health/readiness identify build, and aliases never expose deployment", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); });
  const health = await (await fetch(f.base + "/healthz")).json(); const ready = await (await fetch(f.base + "/readyz")).json();
  assert.deepEqual([health.service, health.protocol, health.build], [SERVICE, PROTOCOL, BUILD]); assert.equal(ready.status, "ready"); assert.equal(health.configId, ready.configId);
  const models = await (await fetch(f.base + "/v1/models")).json(); assert.deepEqual(models.data.map(model => model.id), ["local"]); assert.equal(calls, 0);
  assert.throws(() => createBridgeServer({ azureBase: "http://127.0.0.1" }), /test seam|HTTPS|origin/);
});

test("auth, unknown aliases, unsupported controls, invalid MIME/JSON and budgets never forward", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); });
  for (const [value, options, status] of [[body(), { headers: { Authorization: "Bearer wrong" } }, 401], [body({ model: "unknown" }), {}, 400], [body({ n: 2 }), {}, 400], [body({ max_tokens: 0 }), {}, 400], [body(), { headers: { "Content-Type": "text/plain" } }, 415], [body(), { raw: "{" }, 400]]) {
    assert.equal((await f.post(value, options)).status, status);
  }
  assert.equal(calls, 0);
});

test("WorkBuddy startsNewUserRequest is accepted on the second message and omitted upstream in both response modes", { timeout: 5000 }, async t => {
  const seen = []; const f = await fixture(t, (_url, options) => {
    const payload = JSON.parse(options.body); seen.push(payload);
    return payload.stream ? stream(event("response.completed", { response: completed() })) : json(completed());
  });
  for (const streaming of [false, true]) for (const hint of [false, true]) {
    const request = body({ stream: streaming, messages: [{ role: "system", content: "fixture" }, { role: "user", content: "fixture", startsNewUserRequest: hint }] });
    const response = await f.post(request); assert.equal(response.status, 200);
    const text = await response.text();
    if (streaming) { assert.equal(frames(text).at(-1), "[DONE]"); assert.equal(parsedFrames(text).some(frame => frame.error), false); }
    else assert.equal(JSON.parse(text).choices[0].finish_reason, "stop");
    assert.equal(JSON.stringify(seen.at(-1)).includes("startsNewUserRequest"), false);
    assert.deepEqual(seen.at(-1).input.map(item => item.role), ["system", "user"]);
  }
  assert.equal(seen.length, 4);
});

test("invalid WorkBuddy boundary hints remain local parameterized 400 errors with no upstream request", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); });
  for (const hint of [null, "true", "false", 0, 1, {}, []]) {
    const response = await f.post(body({ messages: [{ role: "system", content: "fixture" }, { role: "user", content: "fixture", startsNewUserRequest: hint }] }));
    assert.equal(response.status, 400); const error = (await response.json()).error;
    assert.equal(error.type, "invalid_request_error"); assert.equal(error.param, "messages[1].startsNewUserRequest");
  }
  assert.equal(calls, 0);
});

test("WorkBuddy 5.8.3-reported agent metadata and standard defaults reach only the supported Responses payload", { timeout: 5000 }, async t => {
  const seen = []; const f = await fixture(t, (_url, options) => {
    const request = JSON.parse(options.body); seen.push(request);
    return request.stream ? stream(event("response.completed", { response: completed() })) : json(completed());
  });
  for (const streaming of [false, true]) for (const agent of [null, "AGENT_PRIVATE_MARKER", { instructions: "AGENT_PRIVATE_MARKER", model: "other" }]) {
    const response = await f.post(body({ stream: streaming, stream_options: null, n: null, max_completion_tokens: null,
      temperature: null, top_p: null, logprobs: false, frequency_penalty: 0, presence_penalty: 0,
      messages: [{ role: "system", content: "fixture" }, { role: "user", content: "PROMPT_PRIVATE_MARKER", startsNewUserRequest: true, agent }] }));
    assert.equal(response.status, 200); const raw = await response.text();
    if (streaming) assert.equal(frames(raw).at(-1), "[DONE]"); else assert.equal(JSON.parse(raw).model, "local");
    const payload = seen.at(-1); assert.equal(payload.model, "fixture-deployment"); assert.equal(payload.store, false); assert.equal(payload.max_output_tokens, 128000);
    for (const key of ["agent", "startsNewUserRequest", "logprobs", "frequency_penalty", "presence_penalty", "stream_options"]) assert.equal(Object.hasOwn(payload, key), false);
    assert.equal(JSON.stringify(payload).includes("AGENT_PRIVATE_MARKER"), false);
    assert.deepEqual(payload.input.map(item => item.role), ["system", "user"]);
  }
  assert.equal(seen.length, 6);
  const records = JSON.stringify(f.logs); assert.equal(records.includes("AGENT_PRIVATE_MARKER"), false); assert.equal(records.includes("PROMPT_PRIVATE_MARKER"), false);
  assert.ok(f.logs.some(record => record.normalizedFields.includes("messages.agent")));
});

test("local validation telemetry distinguishes known unsupported, malformed and unknown fields without private input", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); });
  const cases = [
    [body({ messages: [{ role: "user", content: "PROMPT_PRIVATE_MARKER", name: "NAME_PRIVATE_MARKER" }] }), "unsupported_parameter", "messages[0].name", "string"],
    [body({ max_tokens: "BUDGET_PRIVATE_MARKER" }), "invalid_parameter", "max_tokens", "string"],
    [body({ PRIVATE_FIELD_MARKER: "VALUE_PRIVATE_MARKER" }), "unknown_parameter", "body.<unknown_field>", "string"],
    [body({ messages: [{ role: "user", content: "fixture", agent: "AGENT_PRIVATE_MARKER" + "x".repeat(65536) }] }), "invalid_parameter", "messages[0].agent", "string"],
  ];
  for (const [request, code, param, type] of cases) {
    const response = await f.post(request); assert.equal(response.status, 400); assert.equal((await response.json()).error.code, code);
    const log = f.logs.at(-1); assert.equal(log.stage, "request_conversion"); assert.equal(log.validationCode, code);
    assert.equal(log.validationParam, param); assert.equal(log.validationValueType, type); assert.equal(log.validationType, "invalid_request_error");
  }
  assert.equal(calls, 0);
  const serialized = JSON.stringify(f.logs);
  for (const marker of ["PROMPT_PRIVATE_MARKER", "NAME_PRIVATE_MARKER", "BUDGET_PRIVATE_MARKER", "PRIVATE_FIELD_MARKER", "VALUE_PRIVATE_MARKER", "AGENT_PRIVATE_MARKER"]) assert.equal(serialized.includes(marker), false);
});

test("WorkBuddy conversationRequestId and agent reach neither Azure nor logs in either response mode", { timeout: 5000 }, async t => {
  const seen = []; const f = await fixture(t, (_url, options) => {
    const request = JSON.parse(options.body); seen.push(request);
    return request.stream ? stream(event("response.completed", { response: completed() })) : json(completed());
  });
  for (const streaming of [false, true]) for (const id of [null, "ID_PRIVATE_MARKER", { turn: "ID_PRIVATE_MARKER" }]) {
    const response = await f.post(body({ stream: streaming, messages: [
      { role: "system", content: "fixture" },
      { role: "user", content: "PROMPT_PRIVATE_MARKER", agent: { a: "AGENT_PRIVATE_MARKER" }, conversationRequestId: id, startsNewUserRequest: true },
    ] }));
    assert.equal(response.status, 200); const raw = await response.text();
    if (streaming) assert.equal(frames(raw).at(-1), "[DONE]"); else assert.equal(JSON.parse(raw).model, "local");
    const payload = JSON.stringify(seen.at(-1));
    for (const marker of ["conversationRequestId", "agent", "startsNewUserRequest", "ID_PRIVATE_MARKER", "AGENT_PRIVATE_MARKER"]) assert.equal(payload.includes(marker), false);
    assert.deepEqual(seen.at(-1).input.map(item => item.role), ["system", "user"]);
  }
  assert.equal(seen.length, 6);
  const logs = JSON.stringify(f.logs);
  for (const marker of ["ID_PRIVATE_MARKER", "AGENT_PRIVATE_MARKER", "PROMPT_PRIVATE_MARKER"]) assert.equal(logs.includes(marker), false);
  assert.ok(f.logs.some(record => record.normalizedFields.includes("messages.conversationRequestId")));
  assert.equal(f.logs.every(record => record.status !== 400), true);
});

test("default auto metadata mode processes the WorkBuddy tool-call follow-up and strict mode reports the exact key", { timeout: 5000 }, async t => {
  const seen = []; const f = await fixture(t, (_url, options) => {
    const request = JSON.parse(options.body); seen.push(request); return json(completed());
  });
  const followUp = { messages: [
    { role: "user", content: "PROMPT_PRIVATE_MARKER", agent: { a: "AGENT_PRIVATE_MARKER" } },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":"a"}' } }], turnToken: "TOKEN_PRIVATE_MARKER" },
    { role: "tool", tool_call_id: "call_1", content: "result", isError: false, toolName: "lookup" },
  ], tools: functionTools };
  const auto = await f.post(followUp);
  assert.equal(auto.status, 200); assert.equal((await auto.json()).choices[0].finish_reason, "stop");
  const payload = JSON.stringify(seen.at(-1));
  // Metadata and its values never reach Azure; the prompt itself legitimately does.
  for (const marker of ["turnToken", "isError", "toolName", "TOKEN_PRIVATE_MARKER", "AGENT_PRIVATE_MARKER"]) assert.equal(payload.includes(marker), false);
  assert.equal(payload.includes("PROMPT_PRIVATE_MARKER"), true);
  assert.equal(seen.at(-1).input.length, 3);
  assert.deepEqual(f.logs.at(-1).normalizedFields, ["messages.agent", "messages.isError", "messages.toolName", "messages.turnToken"]);

  const strict = await fixture(t, () => json(completed()), { clientMetadataMode: "strict" });
  const rejected = await strict.post(followUp);
  assert.equal(rejected.status, 400);
  const body = (await rejected.json()).error;
  assert.equal(body.code, "unknown_parameter"); assert.equal(body.param, "messages[1].turnToken");
  const log = strict.logs.at(-1);
  assert.equal(log.validationCode, "unknown_parameter");
  assert.equal(log.validationKey, "turnToken");
  assert.equal(log.validationValueType, "string"); assert.equal(log.stage, "request_conversion");
  assert.equal(JSON.stringify(strict.logs).includes("TOKEN_PRIVATE_MARKER"), false);
});

test("streaming logs the number of bytes actually written downstream", { timeout: 5000 }, async t => {
  const output = [{ type: "message", content: [{ type: "output_text", text: "hello" }] }];
  const f = await fixture(t, () => stream(event("response.output_text.delta", { delta: "hello" }) + event("response.completed", { response: completed({ output }) })));
  const response = await f.post(body({ stream: true })); const raw = await response.text();
  assert.equal(response.status, 200); assert.ok(raw.length > 0);
  const record = f.logs.at(-1);
  assert.equal(record.status, 200); assert.equal(record.stage, "streaming");
  assert.ok(Number.isInteger(record.bytesOut) && record.bytesOut > 0);
  assert.ok(record.bytesOut >= raw.length);
});

test("short credentials never mangle ordinary error text or correlation fields", { timeout: 5000 }, async t => {
  // A credential of one character must not rewrite every matching letter.
  const f = await fixture(t, () => json({ error: { message: "rate limited by upstream", type: "rate_limit_error", code: "slow_down" } }, { status: 429 }), {
    azureApiKey: "k",
  });
  const response = await f.post();
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: { message: "rate limited by upstream", type: "rate_limit_error", code: "slow_down" } });
});

test("JSON translation pins deployment, privacy/budget defaults, summary/refusal/cache counters and no retry", { timeout: 5000 }, async t => {
  let calls = 0, seen;
  const f = await fixture(t, (url, options) => { calls++; seen = { url: String(url), ...options, payload: JSON.parse(options.body) }; return json(completed({ output: [
    { type: "message", content: [{ type: "refusal", refusal: "cannot comply" }] }, { type: "reasoning", encrypted_content: "do-not-expose", summary: [{ type: "summary_text", text: "public" }] },
  ], usage: { input_tokens: 0, output_tokens: 3, total_tokens: 3, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 1 }, output_tokens_details: { reasoning_tokens: 0 } } })); });
  const response = await f.post(); const result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.model, "local"); assert.equal(result.choices[0].message.refusal, "cannot comply"); assert.equal(result.choices[0].message.reasoning_content, "public"); assert.equal(JSON.stringify(result).includes("do-not-expose"), false);
  assert.deepEqual(result.usage.prompt_tokens_details, { cached_tokens: 0, cache_write_tokens: 1 });
  assert.equal(seen.url, "https://example.invalid/openai/v1/responses"); assert.equal(seen.redirect, "error"); assert.equal(seen.payload.model, "fixture-deployment"); assert.equal(seen.payload.store, false); assert.equal(seen.headers["api-key"], UPSTREAM_KEY); assert.equal(calls, 1);
});

test("successful JSON MIME/status/shape and body/error byte limits are enforced", { timeout: 5000 }, async t => {
  let responder = () => json(completed()); const f = await fixture(t, () => responder(), { limits: { jsonBytes: 1024, errorBytes: 128, requestBytes: 1024 } });
  const cases = [() => new Response("oops", { headers: { "Content-Type": "text/plain" } }), () => json({ status: "completed" }), () => json({ status: "queued", output: [] }), () => json(completed(), { status: 201 }), () => json(completed({ output: [{ type: "message", content: [{ type: "output_text", text: "x".repeat(1500) }] }] })), () => json({ error: { message: "x".repeat(200) } }, { status: 429 })];
  for (responder of cases) { const response = await f.post(); assert.equal(response.status, 502); }
  assert.equal((await f.post(body({ messages: [{ role: "user", content: "x".repeat(2000) }] }))).status, 413);
});

test("safe retry/correlation headers and errors preserve advice but never known synthetic credentials", { timeout: 5000 }, async t => {
  let responder = () => json({ error: { message: `${UPSTREAM_KEY} ${LOCAL_TOKEN}`, type: "rate_limit_error", code: "rate_limited", param: "model" } }, { status: 429, headers: { "retry-after": "2", "retry-after-ms": "10", "apim-request-id": "safe-request", "x-private": "not-forwarded" } });
  const f = await fixture(t, () => responder()); const response = await f.post(); const error = await response.json();
  assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "2"); assert.equal(response.headers.get("retry-after-ms"), "10"); assert.equal(response.headers.get("apim-request-id"), "safe-request"); assert.equal(response.headers.get("x-private"), null); assert.equal(error.error.param, "model"); assert.equal(JSON.stringify(error).includes(UPSTREAM_KEY), false);
  responder = () => json(completed(), { headers: { "apim-request-id": UPSTREAM_KEY, "request-id": LOCAL_TOKEN } });
  const malicious = await f.post(); await malicious.text();
  assert.equal(malicious.headers.get("apim-request-id"), null); assert.equal(malicious.headers.get("request-id"), null);
  assert.equal(JSON.stringify(f.logs).includes(UPSTREAM_KEY), false); assert.equal(JSON.stringify(f.logs).includes(LOCAL_TOKEN), false);
});

test("rejected upstream MIME/status bodies are explicitly cancelled even when injection ignores abort", { timeout: 5000 }, async t => {
  let current;
  const f = await fixture(t, () => upstreamWithBody(current.body, current.mime, current.status));
  for (const [mime, status] of [["text/plain", 200], ["application/json", 302]]) {
    current = { ...trackedBody(() => new Promise(() => {})), mime, status };
    assert.equal((await f.post()).status, 502); assert.ok(current.stats.bodyCancel + current.stats.cancel > 0);
  }
});

test("slow healthy JSON bytes refresh idle while stalled bodies/headers and total lifetimes terminate", { timeout: 5000 }, async t => {
  let current;
  const f = await fixture(t, () => current(), { timeouts: { upstreamIdleMs: 40, totalMs: 500 } });
  const bytes = Buffer.from(JSON.stringify(completed()));
  const slow = trackedBody(async n => { await delay(10); return n <= 8 ? { value: bytes.subarray(Math.floor((n - 1) * bytes.length / 8), Math.floor(n * bytes.length / 8)), done: false } : { done: true }; });
  current = () => upstreamWithBody(slow.body); assert.equal((await f.post()).status, 200); assert.equal(slow.stats.release, 1);
  const stalled = trackedBody(() => new Promise(() => {})); current = () => upstreamWithBody(stalled.body);
  assert.equal((await f.post()).status, 504); assert.equal(stalled.stats.cancel, 1); assert.equal(stalled.stats.release, 1);
  current = () => new Promise(() => {}); assert.equal((await f.post()).status, 504);
});

test("streaming respects usage opt-in, typed event fallback, refusal/summary and exactly one DONE", { timeout: 5000 }, async t => {
  const output = [{ type: "message", content: [{ type: "refusal", refusal: "cannot comply" }] }, { type: "reasoning", summary: [{ type: "summary_text", text: "public" }] }];
  const text = event("response.created", { response: { id: "resp_fixture", created_at: 123 } }, "\r\n", true) + event("response.refusal.delta", { delta: "cannot comply" }, "\r\n", true) + event("response.reasoning_summary_text.delta", { delta: "public" }, "\r\n", true) + event("response.completed", { response: completed({ output, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5 } }) }, "\r\n", true);
  const f = await fixture(t, () => stream(text, { step: 1 }));
  for (const includeUsage of [false, true]) {
    const response = await f.post(body({ stream: true, stream_options: { include_usage: includeUsage } })); const raw = await response.text(); const chunks = parsedFrames(raw);
    assert.equal(response.status, 200); assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1); assert.equal(chunks.some(value => value.usage), includeUsage); assert.ok(chunks.every(value => !value.model || value.model === "local"));
    assert.ok(chunks.some(value => value.choices?.[0]?.delta?.refusal === "cannot comply")); assert.ok(chunks.some(value => value.choices?.[0]?.delta?.reasoning_content === "public")); assert.equal(chunks.filter(value => value.usage).every(value => value.choices.length === 0), true);
  }
});

test("large full terminal reconciles delivered text without duplication and retains usage", { timeout: 10000 }, async t => {
  const visible = "x".repeat(1100000); const output = [{ type: "message", content: [{ type: "output_text", text: visible }] }];
  const text = event("response.output_text.delta", { delta: visible }) + event("response.completed", { response: completed({ output, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }) });
  const f = await fixture(t, () => stream(text)); const response = await f.post(body({ stream: true, stream_options: { include_usage: true } }), { signal: AbortSignal.timeout(8000) }); const raw = await response.text(); const chunks = parsedFrames(raw);
  assert.equal(chunks.flatMap(value => value.choices || []).map(choice => choice.delta?.content || "").join(""), visible);
  assert.equal(chunks.some(value => value.error), false); assert.equal(chunks.some(value => value.usage), true); assert.equal(frames(raw).at(-1), "[DONE]");
});

test("tools stay buffered until safe terminal, reconcile done events and preserve parallel calls", { timeout: 5000 }, async t => {
  const first = functionCall(), second = functionCall({ id: "item_2", call_id: "call_2", arguments: '{"key":"b"}' });
  const text = event("response.output_item.added", { output_index: 0, item: { ...first, status: "in_progress", arguments: "" } }) + event("response.function_call_arguments.delta", { output_index: 0, item_id: "item_1", delta: '{"key":' }) + event("response.function_call_arguments.delta", { output_index: 0, item_id: "item_1", delta: '"a"}' }) + event("response.function_call_arguments.done", { output_index: 0, item_id: "item_1", arguments: first.arguments }) + event("response.output_item.done", { output_index: 0, item: first }) + event("response.output_item.done", { output_index: 1, item: second }) + event("response.completed", { response: { id: "resp_fixture", status: "completed" } });
  const f = await fixture(t, () => stream(text)); const response = await f.post(body({ stream: true, tools: functionTools })); const raw = await response.text();
  const tools = toolFrames(raw); assert.equal(tools.length, 2); assert.equal(tools[0].function.arguments, first.arguments); assert.equal(tools[1].id, "call_2"); assert.equal(parsedFrames(raw).at(-1).choices[0].finish_reason, "tool_calls");
});

test("invalid/incomplete/filtered and undeclared tools never appear executable in either mode", { timeout: 5000 }, async t => {
  let current, asStream = false; const f = await fixture(t, () => asStream ? stream(event(current.status === "incomplete" ? "response.incomplete" : "response.completed", { response: current })) : json(current));
  for (asStream of [false, true]) {
    for (const value of [completed({ output: [functionCall({ arguments: '{"key":' })] }), completed({ output: [functionCall(), functionCall()] }), completed({ output: [functionCall({ name: "not_declared" })] }), completed({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [functionCall()] }), completed({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [functionCall()] })]) {
      current = value; const response = await f.post(body({ stream: asStream, tools: functionTools })); const raw = await response.text();
      if (asStream) assert.equal(toolFrames(raw).length, 0);
      else assert.equal(JSON.parse(raw).choices?.[0]?.message?.tool_calls, undefined);
    }
    current = completed({ output: [functionCall()] }); const response = await f.post(body({ stream: asStream, tools: functionTools, tool_choice: "none" })); const raw = await response.text();
    if (asStream) assert.equal(toolFrames(raw).length, 0); else assert.equal(response.status, 502);
  }
});

test("corrupt/conflicting/orphan SSE material fails visibly, EOF never reports success and DONE occurs once", { timeout: 5000 }, async t => {
  let current; const terminal = event("response.completed", { response: completed() }); const f = await fixture(t, () => stream(current));
  const cases = ['event: response.output_text.delta\ndata: {bad json}\n\n' + terminal,
    event("response.output_text.delta", { type: "response.refusal.delta", delta: "x" }) + terminal,
    event("response.function_call_arguments.delta", { output_index: 0, delta: "{}" }) + terminal,
    event("response.output_text.delta", { delta: "hello" }), 'data: [DONE]\n\n',
    event("response.output_item.added", { output_index: 0, item: {} }) + terminal,
    event("response.created", { response: { id: "different_response" } }) + terminal,
  ];
  for (current of cases) {
    const response = await f.post(body({ stream: true })); const raw = await response.text();
    assert.ok(parsedFrames(raw).some(value => value.error)); assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1); assert.equal(parsedFrames(raw).some(value => value.choices?.[0]?.finish_reason === "stop"), false);
  }
});

test("with queueing disabled a saturated bridge rejects immediately without another upstream POST", { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, () => { calls++; entered.resolve(); return release.promise; }, { limits: { maxConcurrent: 1, maxQueue: 0 } });
  const first = f.post(); await entered.promise;
  const second = await f.post(); assert.equal(second.status, 429); assert.equal(second.headers.get("retry-after"), "1"); assert.equal(calls, 1);
  const error = (await second.json()).error;
  assert.equal(error.code, "capacity_exceeded"); assert.equal(error.type, "rate_limit_error");
  release.resolve(json(completed())); assert.equal((await first).status, 200);
});

test("a queued request waits for a slot instead of failing, and logs its queue time", { timeout: 8000 }, async t => {
  const firstEntered = deferred(), releaseFirst = deferred(); let calls = 0;
  const f = await fixture(t, () => {
    calls++;
    if (calls === 1) { firstEntered.resolve(); return releaseFirst.promise; }
    return json(completed());
  }, { limits: { maxConcurrent: 1, maxQueue: 4 }, timeouts: { capacityWaitMs: 3000, totalMs: 6000 } });
  const first = f.post(); await firstEntered.promise;
  const second = f.post();
  await delay(80);                                   // Second request is parked, not sent upstream.
  assert.equal(calls, 1);
  releaseFirst.resolve(json(completed()));
  assert.equal((await first).status, 200);
  const secondResponse = await second;
  assert.equal(secondResponse.status, 200); assert.equal(calls, 2);
  const queuedRecord = f.logs.findLast(record => record.status === 200 && Number.isInteger(record.queuedFor));
  assert.ok(queuedRecord && queuedRecord.queuedFor >= 50, `expected queue time recorded, got ${JSON.stringify(queuedRecord)}`);
});

test("a queued request is rejected once the bounded wait expires", { timeout: 8000 }, async t => {
  const entered = deferred(), release = deferred();
  const f = await fixture(t, () => { entered.resolve(); return release.promise; }, { limits: { maxConcurrent: 1, maxQueue: 2 }, timeouts: { capacityWaitMs: 120 } });
  const first = f.post(); await entered.promise;
  const second = await f.post();
  assert.equal(second.status, 429); assert.equal((await second.json()).error.code, "capacity_exceeded");
  release.resolve(json(completed())); assert.equal((await first).status, 200);
});

test("upload stall, client disconnect and graceful shutdown are bounded and abort in-flight upstream", { timeout: 8000 }, async t => {
  const entered = deferred(); let signal;
  const f = await fixture(t, (_url, options) => { signal = options.signal; entered.resolve(); return new Promise(() => {}); }, { timeouts: { uploadMs: 30, upstreamIdleMs: 2000, shutdownMs: 40 } });
  const upload = http.request(f.base + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, "Content-Type": "application/json" } }); upload.on("error", () => {});
  const uploadResponse = once(upload, "response"); upload.write('{"messages":');
  const [stalled] = await uploadResponse; stalled.resume(); assert.equal(stalled.statusCode, 408); upload.destroy();
  const request = http.request(f.base + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${LOCAL_TOKEN}`, "Content-Type": "application/json" } }); request.on("error", () => {}); request.end(JSON.stringify(body()));
  await entered.promise; const aborted = once(signal, "abort"); request.destroy(); await aborted; assert.equal(signal.aborted, true);
  let nextSignal; const secondEntered = deferred();
  // A separate owned server isolates shutdown from the previous client cancellation.
  const second = await fixture(t, (_url, options) => { nextSignal = options.signal; secondEntered.resolve(); return new Promise(() => {}); }, { timeouts: { upstreamIdleMs: 2000, shutdownMs: 40 } });
  const pending = second.post().then(value => value.text()).catch(() => undefined); await secondEntered.promise;
  await second.server.shutdown(); await pending; assert.equal(nextSignal.aborted, true);
});

test("a named forced function choice is request-scoped, not any declared function", { timeout: 5000 }, async t => {
  let asStream = false; const output = [functionCall({ name: "other" })];
  const f = await fixture(t, () => asStream ? stream(event("response.completed", { response: completed({ output }) })) : json(completed({ output })));
  const tools = [...functionTools, { type: "function", function: { name: "other", parameters: { type: "object" } } }];
  for (asStream of [false, true]) {
    const response = await f.post(body({ stream: asStream, tools, tool_choice: { type: "function", function: { name: "lookup" } } })); const raw = await response.text();
    if (asStream) { assert.equal(toolFrames(raw).length, 0); assert.ok(parsedFrames(raw).some(value => value.error)); }
    else assert.equal(response.status, 502);
  }
});

test("drop-defaults diagnostics contain field names only and upstream usage is logged independently", { timeout: 5000 }, async t => {
  let seen; const f = await fixture(t, (_url, options) => { seen = JSON.parse(options.body); return json(completed({ usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 } } })); }, { samplingPolicy: "drop-defaults" });
  await (await f.post(body({ reasoning_effort: "high", temperature: 1, top_p: 1 }))).text();
  assert.equal(seen.temperature, undefined); assert.equal(seen.top_p, undefined);
  const log = f.logs.find(value => value.model === "local");
  assert.deepEqual(log.normalizedFields, ["temperature", "top_p"]); assert.equal(log.effort, "high"); assert.equal(log.usage.input_tokens_details.cache_write_tokens, 2);
  assert.equal(Object.hasOwn(log, "messages"), false); assert.equal(Object.hasOwn(log, "temperature"), false);
});

test("known no-op events do not duplicate content or terminal output; failed streams preserve error context", { timeout: 5000 }, async t => {
  let text = ["response.content_part.added", "response.content_part.done", "response.output_text.done", "response.refusal.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.done"].map(name => event(name, {})).join("") + event("response.completed", { response: completed() });
  let calls = 0; const f = await fixture(t, () => { calls++; return stream(text); });
  const raw = await (await f.post(body({ stream: true }))).text();
  assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1); assert.equal(parsedFrames(raw).flatMap(value => value.choices || []).map(choice => choice.delta?.content || "").join(""), "hello");
  text = event("response.failed", { response: { status: "failed", error: { message: `${UPSTREAM_KEY} unavailable`, type: "server_error", code: "offline", param: "model" } } });
  const failed = await (await f.post(body({ stream: true }))).text(); const error = parsedFrames(failed).find(value => value.error);
  assert.equal(error.error.code, "offline"); assert.equal(error.error.param, "model"); assert.equal(failed.includes(UPSTREAM_KEY), false); assert.equal(calls, 2);
});

test("function item-ID mismatch and omitted terminal calls fail without any executable tool frame", { timeout: 5000 }, async t => {
  const added = event("response.output_item.added", { output_index: 0, item: { ...functionCall(), status: "in_progress", arguments: "" } });
  let text; const f = await fixture(t, () => stream(text));
  const duplicateIds = event("response.output_item.added", { output_index: 0, item: functionCall({ name: "other" }) }) + event("response.output_item.added", { output_index: 1, item: functionCall() }) + event("response.completed", { response: completed({ output: [functionCall()] }) });
  for (text of [added + event("response.function_call_arguments.delta", { output_index: 0, item_id: "wrong_item", delta: "{}" }) + event("response.completed", { response: completed({ output: [functionCall()] }) }), added + event("response.completed", { response: completed({ output: [] }) }), duplicateIds]) {
    const raw = await (await f.post(body({ stream: true, tools: functionTools }))).text();
    assert.equal(toolFrames(raw).length, 0); assert.ok(parsedFrames(raw).some(value => value.error));
  }
});

test("upstream aggregate streaming bytes are bounded even when each event is small", { timeout: 5000 }, async t => {
  const text = Array.from({ length: 10 }, () => event("response.output_text.delta", { delta: "x".repeat(100) })).join("");
  const f = await fixture(t, () => stream(text, { step: 100 }), { limits: { responseBytes: 900 } });
  const response = await f.post(body({ stream: true })); const raw = await response.text();
  assert.ok(parsedFrames(raw).some(value => value.error)); assert.equal(toolFrames(raw).length, 0); assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1);
});

test("total lifetime terminates otherwise active byte reads separately from upstream idle", { timeout: 5000 }, async t => {
  const reader = trackedBody(async () => { await delay(10); return { value: Buffer.from(" "), done: false }; });
  const f = await fixture(t, () => upstreamWithBody(reader.body), { timeouts: { upstreamIdleMs: 100, totalMs: 50 } });
  const response = await f.post(); assert.equal(response.status, 504); assert.equal((await response.json()).error.code, "total_timeout"); assert.equal(reader.stats.cancel, 1); assert.equal(reader.stats.release, 1);
});

test("disconnect during streaming pending read aborts and cancels/releases the upstream reader", { timeout: 5000 }, async t => {
  let signal; const cancelled = deferred();
  const reader = trackedBody(n => n === 1 ? Promise.resolve({ value: Buffer.from(event("response.output_text.delta", { delta: "visible" })), done: false }) : new Promise(() => {}));
  const f = await fixture(t, (_url, options) => { signal = options.signal; signal.addEventListener("abort", () => cancelled.resolve(), { once: true }); return upstreamWithBody(reader.body, "text/event-stream"); }, { timeouts: { upstreamIdleMs: 2000 } });
  const response = await f.post(body({ stream: true })); const downstream = response.body.getReader(); await downstream.read(); await downstream.cancel(); await cancelled.promise;
  assert.equal(signal.aborted, true);
  // The abort event fires before the awaited read unwinds; wait one event-loop turn.
  await delay(0); assert.equal(reader.stats.cancel, 1); assert.equal(reader.stats.release, 1);
});

test("malformed local JSON reports local validation type and body parameter", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); });
  for (const raw of ["{", Buffer.from([255])]) {
    const response = await f.post(body(), { raw }); const error = await response.json();
    assert.equal(response.status, 400); assert.equal(error.error.type, "invalid_request_error"); assert.equal(error.error.param, "body");
  }
  assert.equal(calls, 0);
});

test("mixed visible text/refusal streaming matches nonstream fields without content duplication", { timeout: 5000 }, async t => {
  const output = [{ type: "message", content: [{ type: "output_text", text: "visible" }, { type: "refusal", refusal: "refused" }] }];
  let asStream = false; const f = await fixture(t, () => asStream ? stream(event("response.output_text.delta", { delta: "visible" }) + event("response.refusal.delta", { delta: "refused" }) + event("response.completed", { response: completed({ output }) })) : json(completed({ output })));
  const expected = (await (await f.post()).json()).choices[0].message;
  asStream = true; const raw = await (await f.post(body({ stream: true }))).text(); const choices = parsedFrames(raw).flatMap(value => value.choices || []);
  assert.equal(choices.map(value => value.delta?.content || "").join(""), expected.content);
  assert.equal(choices.map(value => value.delta?.refusal || "").join(""), expected.refusal);
});

test("terminal failure still records sanitized raw usage even though no success usage chunk is sent", { timeout: 5000 }, async t => {
  const usage = { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 } };
  const f = await fixture(t, () => stream(event("response.failed", { response: { status: "failed", usage, error: { message: "failure", code: "offline" } } })));
  const raw = await (await f.post(body({ stream: true, stream_options: { include_usage: true } }))).text();
  assert.ok(parsedFrames(raw).some(value => value.error)); assert.equal(parsedFrames(raw).some(value => value.usage), false);
  const log = f.logs.find(value => value.model === "local"); assert.equal(log.usage.input_tokens, 2); assert.equal(log.usage.input_tokens_details.cache_write_tokens, 2); assert.equal(log.outcome, "stream_error");
});

test("two concurrent successful requests keep payloads, responses and usage isolated", { timeout: 5000 }, async t => {
  const entries = { first: deferred(), second: deferred() }, releases = { first: deferred(), second: deferred() };
  const f = await fixture(t, (_url, options) => { const prompt = JSON.parse(options.body).input[0].content[0].text; entries[prompt].resolve(); return releases[prompt].promise; });
  const first = f.post(body({ messages: [{ role: "user", content: "first" }] })); const second = f.post(body({ messages: [{ role: "user", content: "second" }] }));
  await Promise.all([entries.first.promise, entries.second.promise]);
  releases.second.resolve(json(completed({ id: "resp_second", output: [{ type: "message", content: [{ type: "output_text", text: "second answer" }] }], usage: { input_tokens: 2 } })));
  const secondResult = await (await second).json();
  releases.first.resolve(json(completed({ id: "resp_first", output: [{ type: "message", content: [{ type: "output_text", text: "first answer" }] }], usage: { input_tokens: 1 } })));
  const firstResult = await (await first).json();
  assert.equal(firstResult.id, "chatcmpl-resp_first"); assert.equal(firstResult.choices[0].message.content, "first answer"); assert.equal(firstResult.usage.prompt_tokens, 1);
  assert.equal(secondResult.id, "chatcmpl-resp_second"); assert.equal(secondResult.choices[0].message.content, "second answer"); assert.equal(secondResult.usage.prompt_tokens, 2);
});

test("upstream error bodies also refresh idle on healthy bytes and clean up a stalled read", { timeout: 5000 }, async t => {
  let current; const f = await fixture(t, () => upstreamWithBody(current.body, "application/json", 429), { timeouts: { upstreamIdleMs: 40 } });
  const bytes = Buffer.from(JSON.stringify({ error: { message: "retry later", code: "rate_limited" } }));
  current = trackedBody(async n => { await delay(10); return n <= 8 ? { value: bytes.subarray(Math.floor((n - 1) * bytes.length / 8), Math.floor(n * bytes.length / 8)), done: false } : { done: true }; });
  const healthy = await f.post(); assert.equal(healthy.status, 429); assert.equal((await healthy.json()).error.code, "rate_limited"); assert.equal(current.stats.release, 1);
  current = trackedBody(() => new Promise(() => {})); const stalled = await f.post(); assert.equal(stalled.status, 504); await stalled.text(); assert.equal(current.stats.cancel, 1); assert.equal(current.stats.release, 1);
});

test("completed terminal output cannot silently omit already streamed material fields", { timeout: 5000 }, async t => {
  let current; const f = await fixture(t, () => stream(current));
  for (const name of ["response.output_text.delta", "response.refusal.delta", "response.reasoning_summary_text.delta"]) {
    current = event(name, { delta: "unconfirmed" }) + event("response.completed", { response: completed({ output: [] }) });
    const raw = await (await f.post(body({ stream: true }))).text();
    assert.ok(parsedFrames(raw).some(value => value.error)); assert.equal(parsedFrames(raw).some(value => value.choices?.[0]?.finish_reason === "stop"), false); assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1);
  }
});

test("annotation-added events preserve terminal sanitized citations without warning or duplication", { timeout: 5000 }, async t => {
  const annotation = { type: "url_citation", url: "https://example.invalid/citation", title: "synthetic citation", start_index: 0, end_index: 5 };
  const output = [{ type: "message", content: [{ type: "output_text", text: "hello", annotations: [annotation] }] }];
  const text = event("response.output_text.delta", { delta: "hello" }) + event("response.output_text.annotation.added", { output_index: 0, content_index: 0, annotation_index: 0, annotation }) + event("response.completed", { response: completed({ output }) });
  const f = await fixture(t, () => stream(text)); const raw = await (await f.post(body({ stream: true }))).text(); const chunks = parsedFrames(raw);
  assert.equal(chunks.some(value => value.error), false); assert.deepEqual(chunks.at(-1).choices[0].delta.annotations, [annotation]); assert.equal(chunks.flatMap(value => value.choices || []).map(value => value.delta?.content || "").join(""), "hello"); assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1);
});

test("queued is a tolerated lifecycle notification before created and never terminates a stream by itself", { timeout: 5000 }, async t => {
  let current; const f = await fixture(t, () => stream(current));
  current = event("response.queued", { response: { id: "resp_queued", created_at: 99 } }) + event("response.created", { response: { id: "resp_queued", created_at: 99 } }) + event("response.output_text.delta", { delta: "hello" }) + event("response.completed", { response: completed({ id: "resp_queued", created_at: 99 }) });
  const response = await f.post(body({ stream: true })); const raw = await response.text(); const chunks = parsedFrames(raw);
  assert.equal(response.status, 200); assert.equal(chunks.some(value => value.error), false);
  assert.equal(chunks.flatMap(value => value.choices || []).map(value => value.delta?.content || "").join(""), "hello");
  assert.equal(chunks.every(value => value.id === "chatcmpl-resp_queued"), true); assert.equal(chunks.every(value => value.created === 99), true);
  assert.equal(chunks.filter(value => value.choices?.[0]?.delta?.role === "assistant").length, 1);
  assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1);
  current = event("response.queued", { response: { id: "resp_queued", created_at: 99 } });
  const incomplete = await (await f.post(body({ stream: true }))).text(); const incompleteChunks = parsedFrames(incomplete);
  assert.ok(incompleteChunks.some(value => value.error)); assert.equal(incompleteChunks.some(value => value.choices?.[0]?.finish_reason === "stop"), false);
  assert.equal(frames(incomplete).filter(value => value === "[DONE]").length, 1);
  current = event("response.queued", { response: "not-an-object" }) + event("response.completed", { response: completed() });
  const malformed = await (await f.post(body({ stream: true }))).text();
  assert.ok(parsedFrames(malformed).some(value => value.error));
});

test("raw reasoning events are accepted, discarded, unlogged and cannot alter reasoning_content", { timeout: 5000 }, async t => {
  const raw = "RAW_REASONING_PRIVATE_MARKER";
  const output = [{ type: "message", content: [{ type: "output_text", text: "hello" }] }, { type: "reasoning", summary: [{ type: "summary_text", text: "public summary" }] }];
  const text = event("response.created", { response: { id: "resp_fixture", created_at: 123 } }) + event("response.reasoning_text.delta", { delta: raw }) + event("response.reasoning_text.done", { text: raw }) + event("response.reasoning_summary_text.delta", { delta: "public summary" }) + event("response.completed", { response: completed({ output }) });
  const f = await fixture(t, () => stream(text));
  const rawResponse = await (await f.post(body({ stream: true }))).text(); const chunks = parsedFrames(rawResponse); const choices = chunks.flatMap(value => value.choices || []);
  assert.equal(chunks.some(value => value.error), false); assert.equal(rawResponse.includes(raw), false); assert.equal(JSON.stringify(chunks).includes(raw), false);
  assert.equal(choices.map(value => value.delta?.content || "").join(""), "hello");
  assert.equal(choices.map(value => value.delta?.reasoning_content || "").join(""), "public summary");
  assert.equal(JSON.stringify(f.logs).includes(raw), false);
  assert.equal(frames(rawResponse).filter(value => value === "[DONE]").length, 1);
});

test("malformed raw reasoning events still fail visibly", { timeout: 5000 }, async t => {
  let current; const f = await fixture(t, () => stream(current));
  for (current of [event("response.reasoning_text.delta", { delta: 42 }), event("response.reasoning_text.done", { text: { nested: "marker" } })]) {
    const raw = await (await f.post(body({ stream: true }))).text(); const chunks = parsedFrames(raw);
    assert.ok(chunks.some(value => value.error)); assert.equal(chunks.some(value => value.choices?.[0]?.finish_reason === "stop"), false);
    assert.equal(frames(raw).filter(value => value === "[DONE]").length, 1);
  }
});

test("unknown events still fail and expose only a sanitized event name in the request log", { timeout: 5000 }, async t => {
  const f = await fixture(t, () => stream(event("response.sunshine.delta", { delta: "opaque material" })));
  const raw = await (await f.post(body({ stream: true }))).text(); const error = parsedFrames(raw).find(value => value.error);
  assert.ok(error); assert.deepEqual(Object.keys(error.error).sort(), ["code", "message", "type"]);
  const record = f.logs.at(-1);
  assert.equal(record.eventName, "response.sunshine.delta"); assert.equal(record.outcome, "stream_error");
  assert.equal(JSON.stringify(record).includes("opaque material"), false);
});

test("secret-bearing and oversized event names are never logged verbatim", { timeout: 5000 }, async t => {
  let current; const f = await fixture(t, () => stream(current));
  const oversized = "response." + "x".repeat(130);
  for (current of [event(`response.${UPSTREAM_KEY}`, {}), event(oversized, {})]) {
    const raw = await (await f.post(body({ stream: true }))).text();
    assert.ok(parsedFrames(raw).some(value => value.error));
    const record = f.logs.at(-1);
    assert.equal(Object.hasOwn(record, "eventName"), false);
    assert.equal(JSON.stringify(record).includes(UPSTREAM_KEY), false);
    assert.equal(JSON.stringify(record).includes("xxxxx"), false);
  }
});

module.exports = { fixture, event, stream, json, completed, functionCall, functionTools, body, frames, parsedFrames, toolFrames };
