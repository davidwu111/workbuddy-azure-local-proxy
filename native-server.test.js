"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const https = require("node:https");
const fs = require("node:fs");
const { createBridgeServer } = require("./server");
const TOKEN = "fixture-local-token", KEY = "fixture-upstream-key";
const msg = () => ({ type: "message", id: "m", role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text: "hello", annotations: [{ type: "url_citation", url: "https://example.invalid", title: "citation" }], logprobs: [], provider_extra: { retained: true } }] });
const completed = (extra = {}) => ({ id: "r", object: "response", created_at: 123, model: "provider-model", status: "completed", output: [msg()], usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, input_tokens_details: { cached_tokens: 1 } }, opaque: { retained: true }, ...extra });
const fn = (extra = {}) => ({ type: "function_call", id: "item-fn", call_id: "call-external", name: "lookup", arguments: "{}", status: "completed", ...extra });
const tool = (name = "lookup") => ({ type: "function", name, strict: false, parameters: { type: "object" } });
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
const sse = text => new Response(text, { headers: { "Content-Type": "text/event-stream" } });
const event = (type, sequence_number, extra = {}, dataOnly = false) => `${dataOnly ? "" : `event: ${type}\n`}data: ${JSON.stringify({ type, sequence_number, ...extra })}\n\n`;
const created = () => event("response.created", 1, { response: { id: "r", status: "in_progress", output: [] } });
const terminal = (response = completed(), sequence = 2) => event(`response.${response.status}`, sequence, { response });
function records(text) { return text.split(/\n\n/).flatMap(frame => { const data = frame.split("\n").filter(s => s.startsWith("data: ")).map(s => s.slice(6)).join("\n"); return data ? [JSON.parse(data)] : []; }); }
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function trackedBody(read, mime = "application/json") {
  const stats = { reads: 0, cancel: 0, release: 0, bodyCancel: 0 };
  const body = { cancel() { stats.bodyCancel++; return Promise.resolve(); }, getReader() { return { read() { return read(++stats.reads); }, cancel() { stats.cancel++; return Promise.resolve(); }, releaseLock() { stats.release++; stats.onRelease?.(); } }; } };
  return { stats, upstream: { status: 200, headers: new Headers({ "Content-Type": mime }), body } };
}
async function fixture(t, fetchImpl, extra = {}) {
  const logs = [];
  const raw = { azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"], azureApiKey: KEY, proxyToken: TOKEN, nativeResponses: true, defaultModel: "local", models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v" } }, ...extra,
    limits: { responseBytes: 1024 ** 2, ...extra.limits }, timeouts: { uploadMs: 1000, upstreamIdleMs: 1000, downstreamStallMs: 500, totalMs: 5000, shutdownMs: 100, capacityWaitMs: 1000, ...extra.timeouts } };
  const server = createBridgeServer(raw, { fetchImpl, logger: (_name, fields) => logs.push(fields) });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); t.after(() => server.shutdown());
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { input: "hello" }, opts = {}) => fetch(base + (opts.path || "/v1/responses"), { method: "POST", headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", ...opts.headers }, body: opts.raw ?? JSON.stringify(body), signal: opts.signal || AbortSignal.timeout(opts.timeoutMs || 4000) });
  return { server, logs, base, post };
}

test("native create remains default-off and read/delete/chaining routes are absent", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); }, { nativeResponses: false });
  assert.equal((await f.post()).status, 404); assert.equal(calls, 0);
  for (const method of ["GET", "DELETE"]) assert.equal((await fetch(f.base + "/v1/responses/r", { method })).status, 404);
});
test("JSON native routing pins deployment, secret header and output limit while preserving full native output", { timeout: 5000 }, async t => {
  let sent, calls = 0; const result = completed();
  const f = await fixture(t, (url, opts) => { calls++; sent = JSON.parse(opts.body); assert.equal(String(url), "https://example.invalid/openai/v1/responses"); assert.equal(opts.redirect, "error"); assert.equal(opts.headers["api-key"], KEY); assert.equal(opts.headers.Authorization, undefined); return json(result); });
  const res = await f.post({ model: "local", input: [{ role: "user", content: "hello" }] }, { headers: { "api-key": "untrusted", "x-ms-session-id": "untrusted" } });
  assert.equal(res.status, 200); assert.deepEqual(await res.json(), result); assert.equal(sent.model, "deployment"); assert.equal(sent.store, false); assert.equal(sent.max_output_tokens, 128000); assert.equal(calls, 1);
  assert.equal(f.logs.at(-1).path, "/v1/responses"); assert.equal(f.logs.at(-1).model, "local"); assert.ok(f.logs.at(-1).bytesOut > 0);
});
test("SSE preserves native types, metadata, opaque fields and numeric usage without Chat DONE", { timeout: 5000 }, async t => {
  const raw = ":pulse\nid:\nretry: 0005\n\n" + event("response.created", 1, { response: { id: "r", status: "in_progress", output: [] } }, true) + event("response.output_text.delta", 2, { item_id: "m", output_index: 0, content_index: 0, delta: "hello", logprobs: [] }, true) + terminal(completed(), 3);
  const f = await fixture(t, () => sse(raw)); const res = await f.post({ input: "hello", stream: true }); const text = await res.text();
  assert.equal(res.status, 200); assert.match(res.headers.get("content-type"), /^text\/event-stream/);
  assert.ok(text.includes(": pulse\n") && text.includes("id: \n") && text.includes("retry: 0005\n"));
  assert.deepEqual(records(text).at(-1).response, completed()); assert.ok(!text.includes("[DONE]") && !text.includes('"choices"'));
  const log = f.logs.at(-1); assert.equal(log.usage.total_tokens, 5); assert.ok(log.bytesOut > 0); assert.ok(log.firstTokenMs >= 0);
});
test("native auth, malformed MIME/JSON/UTF8, route aliases and query controls fail locally", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); });
  for (const [body, opts, status] of [[{ input: "x" }, { headers: { Authorization: "Bearer wrong" } }, 401], [{ input: "x" }, { headers: { "Content-Type": "text/plain" } }, 415], [null, { raw: "{" }, 400], [null, { raw: Buffer.from([123,255,125]) }, 400], [{ input: "x", model: "deployment" }, {}, 400], [{ input: "x" }, { path: "/v1/responses?background=true" }, 400]]) assert.equal((await f.post(body, opts)).status, status);
  assert.equal(calls, 0);
});
test("encoded native outbound budgets are checked after defaults as well as upload limits", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); }, { limits: { requestBytes: 128 } });
  assert.equal((await f.post({ input: "x".repeat(200) })).status, 413);
  assert.equal((await f.post({ input: "x".repeat(90) })).status, 413); assert.equal(calls, 0);
});
test("deferred storage, state, hosted/custom tools and media cannot reach upstream even with Chat store consent", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json(completed()); }, { allowStore: true, defaults: { store: true } });
  const bodies = [{ store: true }, { background: true }, { previous_response_id: "r" }, { conversation: "c" }, { agent_reference: { name: "x" } }, { tools: [{ type: "mcp", server_url: "https://external.invalid" }] }, { tools: [{ type: "custom", name: "x" }] }, { input: [{ role: "user", content: [{ type: "input_image", image_url: "https://external.invalid" }] }] }];
  for (const b of bodies) assert.equal((await f.post({ input: "x", ...b })).status, 400);
  assert.equal(calls, 0);
});
test("native JSON functions honor root name-based choice and preserve provider call IDs", { timeout: 5000 }, async t => {
  let sent; const f = await fixture(t, (_url, opts) => { sent = JSON.parse(opts.body); return json(completed({ output: [fn()] })); }, { nativePolicies: { local: { features: [], customToolNames: ["lookup"] } } });
  const choice = { type: "function", name: "lookup" }; const res = await f.post({ input: "x", tools: [tool()], tool_choice: choice });
  assert.equal(res.status, 200); assert.deepEqual((await res.json()).output, [fn()]); assert.deepEqual(sent.tool_choice, choice);
  assert.equal((await f.post({ input: "x", tools: [tool()], tool_choice: { type: "function", function: { name: "lookup" } } })).status, 400);
});
test("native streaming functions correlate distinct item/call IDs and retain partial/done/terminal data", { timeout: 5000 }, async t => {
  const raw = created() + event("response.output_item.added", 2, { output_index: 0, item: fn({ arguments: "", status: "in_progress" }) }) + event("response.function_call_arguments.delta", 3, { output_index: 0, item_id: "item-fn", delta: "{" }) + event("response.function_call_arguments.done", 4, { output_index: 0, item_id: "item-fn", name: "lookup", arguments: "{}" }) + event("response.output_item.done", 5, { output_index: 0, item: fn() }) + terminal(completed({ output: [fn()] }), 6);
  const f = await fixture(t, () => sse(raw), { nativePolicies: { local: { features: [], customToolNames: ["lookup"] } } }); const text = await (await f.post({ input: "x", tools: [tool()], tool_choice: { type: "function", name: "lookup" }, stream: true })).text();
  const parsed = records(text); assert.ok(parsed.some(p => p.type === "response.function_call_arguments.delta")); assert.deepEqual(parsed.at(-1).response.output, [fn()]); assert.ok(!text.includes("bridge.error") && !text.includes("[DONE]"));
});
test("unexpected functions and nested specialized outputs return promptly in JSON and fail visibly in SSE", { timeout: 8000 }, async t => {
  let output, streaming; const f = await fixture(t, () => streaming ? sse(terminal(completed({ output }), 1)) : json(completed({ output })), { nativePolicies: { local: { features: [], customToolNames: ["lookup"] } } });
  for (streaming of [false, true]) for (output of [[fn({ name: "unrequested" })], [msg(), { type: "web_search_call", id: "web" }], [{ ...msg(), content: [{ type: "output_audio", data: "AAA" }] }]]) {
    const res = await f.post({ input: "x", tools: [tool()], stream: streaming });
    if (!streaming) { assert.equal(res.status, 502); assert.equal((await res.json()).error.code, "native_policy_rejected"); }
    else { const parsed = records(await res.text()); assert.equal(parsed.length, 1); assert.equal(parsed[0].type, "bridge.error"); assert.equal(parsed[0].error.code, "native_policy_rejected"); }
  }
});
test("known specialized event groups are denied before frame delivery rather than merely by malformed fixtures", { timeout: 5000 }, async t => {
  const f = await fixture(t, () => sse(created() + event("response.web_search_call.in_progress", 2, { output_index: 0, item_id: "web" }) + terminal(completed(), 3)));
  const text = await (await f.post({ input: "x", stream: true })).text(); assert.equal(records(text).at(-1).error.code, "native_policy_rejected"); assert.equal(text.includes("event: response.web_search_call"), false);
});
test("foreground native failed/incomplete/cancelled responses and targeted error redaction remain native", { timeout: 5000 }, async t => {
  let current; const f = await fixture(t, () => json(current));
  for (const status of ["failed", "incomplete", "cancelled"]) {
    current = completed({ status, output: [], error: status === "failed" ? { code: "busy", message: KEY } : null, opaque: { text: KEY } });
    const res = await f.post(); assert.equal(res.status, 200); const got = await res.json(); assert.equal(got.status, status); assert.equal(got.opaque.text, KEY); if (status === "failed") assert.equal(got.error.message, "[redacted]");
  }
  for (const status of ["queued", "in_progress"]) { current = completed({ status }); assert.equal((await f.post()).status, 502); }
});
test("provider SSE flat/nested error and failed terminals stay native with no duplicate local failure", { timeout: 5000 }, async t => {
  let raw; const f = await fixture(t, () => sse(raw));
  for (const p of [{ type: "error", sequence_number: 1, code: "busy", param: null, message: KEY }, { type: "error", error: { type: "server_error", code: "busy", message: KEY } }, { type: "response.failed", sequence_number: 1, response: completed({ status: "failed", output: [], error: { message: KEY } }) }]) {
    raw = `event: ${p.type}\ndata: ${JSON.stringify(p)}\n\n`; const text = await (await f.post({ input: "x", stream: true })).text(); const parsed = records(text); assert.equal(parsed.length, 1); assert.equal(parsed[0].type, p.type); assert.ok(!text.includes(KEY) && !text.includes("bridge.error") && !text.includes("[DONE]"));
  }
});
test("malformed native upstream status/MIME/JSON and response shape fail before streaming headers", { timeout: 5000 }, async t => {
  let upstream; const f = await fixture(t, () => upstream);
  for (upstream of [new Response("x", { status: 201, headers: { "Content-Type": "application/json" } }), new Response("x", { headers: { "Content-Type": "text/plain" } }), new Response("{bad", { headers: { "Content-Type": "application/json" } }), json({ id: "r", status: "completed", output: {} }), json(completed({ object: "chat.completion" }))]) { const res = await f.post(); assert.equal(res.status, 502); assert.match(res.headers.get("content-type"), /^application\/json/); }
  upstream = json(completed()); assert.equal((await f.post({ input: "x", stream: true })).status, 502);
  upstream = sse(terminal()); assert.equal((await f.post({ input: "x", stream: false })).status, 502);
});
test("upstream HTTP errors retain safe status/retry advice and redact credentials without retry", { timeout: 5000 }, async t => {
  let calls = 0; const f = await fixture(t, () => { calls++; return json({ error: { code: "rate", type: "rate_limit_error", message: KEY } }, 429, { "retry-after": "2", "apim-request-id": "safe-id", "x-private": KEY }); });
  const res = await f.post(); assert.equal(res.status, 429); assert.equal(res.headers.get("retry-after"), "2"); assert.equal(res.headers.get("apim-request-id"), "safe-id"); assert.equal(res.headers.get("x-private"), null); assert.equal((await res.json()).error.message, "[redacted]"); assert.equal(calls, 1);
});
test("native HTTP error logs carry the provider code only when it is a safe bounded token", { timeout: 5000 }, async t => {
  let status = 429, error; const f = await fixture(t, () => json({ error }, status));
  for (const [nextStatus, source, expected] of [
    [429, { code: "rate_limit_exceeded", type: "rate_limit_error", message: "slow down" }, "rate_limit_exceeded"],
    [429, { code: "not a token", message: "slow down" }, "429"],
    [400, { message: "slow down" }, "400"],
    [429, { code: KEY, message: "slow down" }, "429"],
  ]) {
    status = nextStatus; error = source; const res = await f.post(); assert.equal(res.status, nextStatus); await res.text();
    const record = f.logs.at(-1); assert.equal(record.outcome, "upstream_http_error"); assert.equal(record.code, expected);
    assert.equal(JSON.stringify(record).includes(KEY), false);
  }
});
test("midstream corruption and terminal-less EOF send one bridge.error, safe code and byte metrics", { timeout: 5000 }, async t => {
  let calls = 0, raw = "event: response.output_text.delta\ndata: {bad}\n\n";
  const f = await fixture(t, () => { calls++; return sse(raw); });
  let text = await (await f.post({ input: "x", stream: true })).text(); assert.equal(records(text).length, 1); assert.equal(records(text)[0].type, "bridge.error"); assert.equal(f.logs.at(-1).code, "invalid_sse_json"); assert.ok(f.logs.at(-1).bytesOut > 0);
  raw = created(); text = await (await f.post({ input: "x", stream: true })).text(); assert.equal(records(text).at(-1).error.code, "missing_sse_terminal"); assert.equal(calls, 2); assert.ok(!text.includes("[DONE]"));
});
test("logs keep only safe metadata and numeric usage, not native prompts, responses or opaque values", { timeout: 5000 }, async t => {
  const marker = "PRIVATE_NATIVE_CONTENT"; const result = completed({ model: marker, opaque: { marker }, usage: { input_tokens: 2, output_tokens: 3, total_tokens: 5, opaque: marker } }); result.output[0].content[0].text = marker;
  const f = await fixture(t, () => json(result)); const got = await (await f.post({ input: marker, instructions: marker })).json(); assert.equal(got.model, marker); assert.equal(got.opaque.marker, marker);
  assert.equal(JSON.stringify(f.logs).includes(marker), false); assert.equal(f.logs.at(-1).usage.total_tokens, 5); assert.equal(f.logs.at(-1).model, "local");
});
test("native and Chat routes share admission slots and queued requests resume without a second server", { timeout: 5000 }, async t => {
  const entered = deferred(), release = deferred(); let calls = 0;
  const f = await fixture(t, () => { if (++calls === 1) { entered.resolve(); return release.promise; } return json(completed()); }, { limits: { maxConcurrent: 1, maxQueue: 1 } });
  const first = f.post(); await entered.promise;
  const second = f.post({ messages: [{ role: "user", content: "x" }] }, { path: "/v1/chat/completions" });
  release.resolve(json(completed())); assert.equal((await first).status, 200); const chat = await second; assert.equal(chat.status, 200); assert.equal((await chat.json()).choices[0].message.content, "hello"); assert.equal(calls, 2);
});
test("native reader idle and total lifetime failures are bounded and dispose the upstream reader", { timeout: 5000 }, async t => {
  let current = trackedBody(() => new Promise(() => {}));
  const f = await fixture(t, () => current.upstream, { timeouts: { upstreamIdleMs: 20, totalMs: 1000 } });
  assert.equal((await f.post()).status, 504); assert.equal(current.stats.cancel, 1); assert.equal(current.stats.release, 1);
  current = trackedBody(() => new Promise(() => {}), "text/event-stream"); const text = await (await f.post({ input: "x", stream: true })).text(); assert.equal(records(text).at(-1).error.code, "upstream_idle_timeout"); assert.equal(current.stats.release, 1);
  const pending = trackedBody(() => new Promise(() => {})); const total = await fixture(t, () => pending.upstream, { timeouts: { upstreamIdleMs: 1000, totalMs: 25 } }); assert.equal((await total.post()).status, 504); assert.equal(pending.stats.release, 1);
});
test("native disconnect propagates abort and releases a pending upstream stream", { timeout: 5000 }, async t => {
  const aborted = deferred(), disposed = deferred(); const upstream = trackedBody(n => n === 1 ? Promise.resolve({ value: Buffer.from(created()), done: false }) : new Promise(() => {}), "text/event-stream");
  upstream.stats.onRelease = () => disposed.resolve();
  const f = await fixture(t, (_url, opts) => { opts.signal.addEventListener("abort", () => aborted.resolve(), { once: true }); return upstream.upstream; });
  const res = await f.post({ input: "x", stream: true }); const reader = res.body.getReader(); await reader.read(); await reader.cancel(); await aborted.promise; await disposed.promise;
  assert.equal(upstream.stats.cancel, 1); assert.equal(upstream.stats.release, 1);
});
test("native shutdown bounds in-flight requests and queued capacity does not bypass limits", { timeout: 5000 }, async t => {
  const entered = deferred(); let aborted = false;
  const f = await fixture(t, (_url, opts) => { entered.resolve(); return new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => { aborted = true; reject(opts.signal.reason); }, { once: true })); }, { limits: { maxConcurrent: 1, maxQueue: 0 }, timeouts: { shutdownMs: 25 } });
  const first = f.post().catch(() => null); await entered.promise; assert.equal((await f.post()).status, 429); await f.server.shutdown(); await first; assert.equal(aborted, true);
});
test("native JSON and SSE respect configured body and downstream byte limits", { timeout: 5000 }, async t => {
  const huge = completed({ opaque: "x".repeat(2048) }); const f = await fixture(t, () => json(huge), { limits: { responseBytes: 512, jsonBytes: 512 } }); assert.equal((await f.post()).status, 502);
  let sent = false; const invalid = trackedBody(() => new Promise(() => {}), "text/plain"); const g = await fixture(t, () => { sent = true; return invalid.upstream; }); assert.equal((await g.post()).status, 502); assert.equal(sent, true); assert.equal(invalid.stats.bodyCancel, 1);
});
test("native SSE uses configured response budget rather than the isolated 16 MiB default", { timeout: 15000 }, async t => {
  const bytes = 17 * 1024 ** 2; const value = completed({ opaque: "x".repeat(bytes) }); const text = terminal(value, 1);
  const f = await fixture(t, () => sse(text), { limits: { responseBytes: 24 * 1024 ** 2, sseLineBytes: 24 * 1024 ** 2, sseEventBytes: 24 * 1024 ** 2, sseBufferBytes: 48 * 1024 ** 2 }, timeouts: { totalMs: 12000, downstreamStallMs: 5000 } });
  const res = await f.post({ input: "x", stream: true }, { timeoutMs: 14000 }); const got = await res.text(); assert.equal(res.status, 200); assert.ok(Buffer.byteLength(got) > bytes); assert.ok(!got.includes("bridge.error")); assert.ok(f.logs.at(-1).bytesOut > 16 * 1024 ** 2);
});
test("native storage opt-in needs all three grants and leaves Chat defaults untouched", { timeout: 5000 }, async t => {
  let sent; const consent = { allowStore: true, nativePolicies: { local: { allowStore: true } } };
  const f = await fixture(t, (_url, opts) => { sent = JSON.parse(opts.body); return json(completed()); }, consent);
  assert.equal((await f.post({ input: "x" })).status, 200); assert.equal(sent.store, false);
  assert.equal((await f.post({ input: "x", store: true })).status, 200); assert.equal(sent.store, true);
  const routeOnly = await fixture(t, () => json(completed()), { allowStore: true, nativePolicies: { local: { allowStore: false } } });
  assert.equal((await routeOnly.post({ input: "x", store: true })).status, 400);
  const globalOnly = await fixture(t, () => json(completed()), { allowStore: false, nativePolicies: { local: { allowStore: true } } });
  assert.equal((await globalOnly.post({ input: "x", store: true })).status, 400);
});
test("MCP requires allowlisted tools, preserves approval requests and never auto-approves", { timeout: 5000 }, async t => {
  const policy = { nativePolicies: { local: { features: ["mcp"], mcpServers: [{ label: "tools", url: "https://mcp.example/api", toolNames: ["search"] }] } } };
  const tool = { type: "mcp", server_label: "tools", server_url: "https://mcp.example/api", allowed_tools: ["search"] };
  const request = { type: "mcp_approval_request", id: "approve-1", server_label: "tools", name: "search", arguments: "{}" };
  const raw = created() + event("response.output_item.added", 2, { output_index: 0, item: request }) + event("response.output_item.done", 3, { output_index: 0, item: { ...request, status: "completed" } }) + terminal(completed({ output: [{ ...request, status: "completed" }] }), 4);
  const f = await fixture(t, () => sse(raw), policy);
  const res = await f.post({ input: "x", tools: [tool], stream: true }); const text = await res.text();
  assert.equal(res.status, 200); assert.ok(text.includes("mcp_approval_request")); assert.ok(!text.includes('"approve":true'));
  const denied = await fixture(t, () => json(completed()), policy);
  assert.equal((await denied.post({ input: "x", tools: [{ ...tool, allowed_tools: ["write"] }] })).status, 400);
  const noPolicy = await fixture(t, () => json(completed()));
  assert.equal((await noPolicy.post({ input: "x", tools: [tool] })).status, 400);
});
test("a granted hosted feature streams its native events instead of failing closed", { timeout: 5000 }, async t => {
  const policy = { nativePolicies: { local: { features: ["web-search"] } } };
  const tool = { type: "web_search", search_context_size: "medium" };
  const item = { type: "web_search_call", id: "web-1", status: "completed", action: { type: "search", query: "hello" } };
  const raw = created() + event("response.output_item.added", 2, { output_index: 0, item: { ...item, status: "in_progress" } })
    + event("response.web_search_call.searching", 3, { output_index: 0, item_id: "web-1" })
    + event("response.web_search_call.completed", 4, { output_index: 0, item_id: "web-1" })
    + event("response.output_item.done", 5, { output_index: 0, item }) + terminal(completed({ output: [item] }), 6);
  const f = await fixture(t, () => sse(raw), policy);
  const res = await f.post({ input: "x", tools: [tool], stream: true }); const text = await res.text();
  assert.equal(res.status, 200); assert.ok(text.includes("response.web_search_call.searching")); assert.ok(!text.includes("bridge.error"));
});
test("annotations and returned resources stay inside the request-scoped grant", { timeout: 5000 }, async t => {
  const policy = { nativePolicies: { local: { features: ["file-search"], vectorStoreIds: ["vs_1", "vs_2"], fileIds: ["f1", "f2"] } } };
  let output;
  const f = await fixture(t, () => json(completed({ output })), policy);
  const cited = fileId => ({ type: "message", id: "m1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [{ type: "file_citation", file_id: fileId }] }] });
  output = [cited("f1")]; assert.equal((await f.post()).status, 200);
  output = [cited("unapproved")]; assert.equal((await f.post()).status, 502);
  const search = { type: "file_search", vector_store_ids: ["vs_1"] };
  output = [{ type: "file_search_call", id: "fs1", status: "completed", queries: ["q"], results: [{ file_id: "f1", vector_store_id: "vs_2" }] }];
  assert.equal((await f.post({ input: "x", tools: [search] })).status, 502);
  output = [{ type: "file_search_call", id: "fs1", status: "completed", queries: ["q"], results: [{ file_id: "f1", vector_store_id: "vs_1" }] }];
  assert.equal((await f.post({ input: "x", tools: [search] })).status, 200);
});
test("image generation routing header is configured once server-side and never client-controlled", { timeout: 5000 }, async t => {
  let sent; const extra = { nativePolicies: { local: { features: ["image-generation"], imageModels: ["gpt-image-1"] } },
    models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v", nativeHeaders: { "x-ms-oai-image-generation-deployment": "img-deploy" } } } };
  const f = await fixture(t, (_url, opts) => { sent = opts.headers; return json(completed()); }, extra);
  const tools = [{ type: "image_generation", model: "gpt-image-1" }];
  assert.equal((await f.post({ input: "x", tools })).status, 200);
  assert.equal(sent["x-ms-oai-image-generation-deployment"], "img-deploy");
  assert.equal((await f.post({ input: "x" })).status, 200);
  assert.equal(sent["x-ms-oai-image-generation-deployment"], undefined);
  assert.equal((await f.post({ input: "x", tools }, { headers: { "x-ms-oai-image-generation-deployment": "client-value" } })).status, 200);
  assert.equal(sent["x-ms-oai-image-generation-deployment"], "img-deploy");
});
test("native create uses the existing TLS listener with real certificate verification", { timeout: 5000 }, async t => {
  const certPath = "test-fixtures/tls/localhost-cert.pem", keyPath = "test-fixtures/tls/localhost-key.pem";
  const f = await fixture(t, () => json(completed()), { tlsCert: certPath, tlsKey: keyPath });
  const port = f.server.address().port;
  const response = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ input: "x" }); const req = https.request({ hostname: "127.0.0.1", port, path: "/v1/responses", method: "POST", ca: fs.readFileSync(certPath), headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) } }, res => { let data = ""; res.setEncoding("utf8"); res.on("data", text => { data += text; }); res.on("end", () => resolve({ status: res.statusCode, data })); }); req.on("error", reject); req.end(body);
  });
  assert.equal(response.status, 200); assert.equal(JSON.parse(response.data).model, "provider-model");
});
test("encrypted reasoning and logprobs are forwarded and relayed unchanged", { timeout: 5000 }, async t => {
  const reasoning = { type: "reasoning", id: "rs_1", encrypted_content: "gAAAA-blob", summary: [] };
  const message = { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [], logprobs: [{ token: "hi", logprob: -0.25 }] }] };
  const response = { id: "r", status: "completed", output: [reasoning, message], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 } };
  const raw = event("response.created", 1, { response: { id: "r", status: "in_progress", output: [] } })
    + event("response.output_item.done", 2, { output_index: 0, item: reasoning })
    + event("response.output_text.delta", 3, { item_id: "msg_1", output_index: 1, content_index: 0, delta: "hi", logprobs: [{ token: "hi", logprob: -0.25 }] })
    + event("response.completed", 4, { response });
  let sent; const f = await fixture(t, (_url, opts) => { sent = JSON.parse(opts.body); return sse(raw); });
  const res = await f.post({ input: "hi", stream: true, include: ["reasoning.encrypted_content", "message.output_text.logprobs"], top_logprobs: 2 });
  const text = await res.text();
  assert.deepEqual(sent.include, ["reasoning.encrypted_content", "message.output_text.logprobs"]); assert.equal(sent.top_logprobs, 2);
  assert.equal(res.status, 200); assert.ok(text.includes("gAAAA-blob")); assert.ok(text.includes('"logprob":-0.25'));
  assert.deepEqual(records(text).at(-1).response, response); assert.ok(!text.includes("[DONE]"));
});
