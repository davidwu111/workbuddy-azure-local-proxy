"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const vm = require("node:vm");
const http = require("node:http");
const inventory = require("./test-fixtures/azure-responses/event-inventory.json");
const eventsModule = require("./native-events");
const { EVENT_REGISTRY, COMPATIBILITY_EVENTS, FEATURE_CATEGORIES, validateNativeEvent } = eventsModule;
const { DEFAULT_LIMITS, parseNativeSse, createNativeTracker, validateRecord, encodeRecord, NativeSseWriter, relayNativeSse, boundedLocalError } = require("./native-sse");
const limits = { ...DEFAULT_LIMITS };
const terminalNames = new Set(["response.completed", "response.failed", "response.incomplete", "error"]);
const allow = () => true;
function payloadFor(name, sequence = 1) {
  const p = { type: name, sequence_number: sequence };
  const category = EVENT_REGISTRY[name]?.category;
  const statuses = { "response.created": "in_progress", "response.queued": "queued", "response.in_progress": "in_progress", "response.completed": "completed", "response.failed": "failed", "response.incomplete": "incomplete", "response.cancelled": "cancelled" };
  if (Object.hasOwn(statuses, name)) return { ...p, response: { id: "r", status: statuses[name], output: [], model: "provider-model", error: null, incomplete_details: null } };
  if (name === "error") return { ...p, code: null, message: "provider failure", param: null };
  if (category !== "audio") { p.output_index = 0; if (category !== "output-item-lifecycle") p.item_id = "i0"; }
  if (name.endsWith(".delta")) p.delta = category === "audio" ? "YWJj" : "partial";
  if (["output-text", "refusal", "raw-reasoning", "message-content-lifecycle", "annotation"].includes(category)) p.content_index = 0;
  if (category === "reasoning-summary") p.summary_index = 0;
  if (category === "output-item-lifecycle") p.item = { id: "i0", type: "message", role: "assistant", content: [] };
  if (category === "message-content-lifecycle") p.part = { type: "output_text", text: "hello", annotations: [] };
  if (name.startsWith("response.reasoning_summary_part.")) p.part = { type: "summary_text", text: "summary" };
  if (name === "response.output_text.annotation.added") { p.annotation_index = 0; p.annotation = { type: "url_citation", url: "https://example.invalid", title: "citation", start_index: 0, end_index: 1 }; }
  if (name === "response.image_generation_call.partial_image") { p.partial_image_b64 = "YWJj"; p.partial_image_index = 0; }
  if (["response.function_call_arguments.done", "response.mcp_call_arguments.done"].includes(name)) p.arguments = '{"x":1}';
  if (name === "response.function_call_arguments.done") p.name = "lookup";
  if (name === "response.custom_tool_call_input.done") p.input = "free form";
  if (name === "response.code_interpreter_call_code.done") p.code = "print(1)";
  if (name === "response.refusal.done") p.refusal = "cannot comply";
  if (["response.output_text.done", "response.reasoning_summary_text.done", "response.reasoning_text.done"].includes(name)) p.text = "hello";
  if (category === "output-text") p.logprobs = [];
  return p;
}
function frame(payload, { event = payload.type, ending = "\n" } = {}) { return `${event === null ? "" : `event: ${event}${ending}`}data: ${JSON.stringify(payload)}${ending}${ending}`; }
async function* fragmented(input, step = 1) { const b = Buffer.isBuffer(input) ? input : Buffer.from(input); for (let i = 0; i < b.length; i += step) yield b.subarray(i, i + step); }
async function collect(iterable) { const result = []; for await (const value of iterable) result.push(value); return result; }
class ResponseFixture extends EventEmitter {
  constructor(write = () => true) { super(); this.frames = []; this.destroyed = false; this.writableEnded = false; this.writableNeedDrain = false; this.headersSent = false; this.writeFn = write; }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  flushHeaders() {}
  write(text) { this.frames.push(text); const ok = this.writeFn(text, this.frames.length); if (!ok) this.writableNeedDrain = true; return ok; }
  end() { this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}
function trackedBody(read) {
  const stats = { reads: 0, cancel: 0, release: 0 };
  return { stats, body: { getReader() { return { read() { return read(++stats.reads); }, cancel() { stats.cancel++; return Promise.resolve(); }, releaseLock() { stats.release++; } }; } } };
}
function bytesBody(text, step = 23) { const b = Buffer.isBuffer(text) ? text : Buffer.from(text); let at = 0; return trackedBody(() => Promise.resolve(at >= b.length ? { done: true } : { value: b.subarray(at, Math.min(at += step, b.length)), done: false })); }
function run(text, options = {}) {
  const source = options.source || bytesBody(text, options.step || 23), res = options.res || new ResponseFixture();
  const promise = relayNativeSse({ body: source.body }, res, { limits: { ...limits, ...options.limits }, timeouts: { upstreamIdleMs: 500, downstreamStallMs: 30, policyMs: 100, ...options.timeouts }, beforeEmit: allow, ...options, source: undefined, res: undefined });
  return { source, res, promise };
}
async function nativeRecords(text) { return collect(parseNativeSse(fragmented(text, 7))); }

test("registry exactly matches the endpoint inventory, is deeply frozen and has no prototype aliases", () => {
  assert.deepEqual(Object.keys(EVENT_REGISTRY).sort(), inventory.entries.map(e => e.name).sort());
  assert.equal(Object.keys(EVENT_REGISTRY).length, 53); assert.equal(Object.getPrototypeOf(EVENT_REGISTRY), null);
  for (const e of inventory.entries) { assert.equal(EVENT_REGISTRY[e.name].category, e.category); assert.ok(Object.isFrozen(EVENT_REGISTRY[e.name].fields)); }
  assert.ok(Object.isFrozen(EVENT_REGISTRY)); assert.ok(Object.isFrozen(COMPATIBILITY_EVENTS));
  assert.equal(Object.hasOwn(EVENT_REGISTRY, "response.cancelled"), false); assert.equal(COMPATIBILITY_EVENTS["response.cancelled"].inDocumentedEnum, false);
  assert.equal(inventory.entries.filter(e => FEATURE_CATEGORIES.includes(e.category)).length, 29);
  for (const name of ["constructor", "__proto__", "toString"]) assert.equal(validateNativeEvent(name, { type: name }).known, false);
});
for (const name of Object.keys(EVENT_REGISTRY)) test(`native event coverage: ${name}`, async () => {
  const payload = payloadFor(name); assert.equal(validateNativeEvent(name, payload).known, true);
  for (const key of Object.keys(EVENT_REGISTRY[name].fields)) { const bad = { ...payload }; delete bad[key]; assert.throws(() => validateNativeEvent(name, bad), { code: "invalid_native_shape" }, `${name}/${key}`); }
  const text = frame(payload) + (terminalNames.has(name) ? "" : frame(payloadFor("response.completed", 2)));
  const r = run(text); const result = await r.promise; assert.equal(result.terminal, true);
  const records = await nativeRecords(r.res.frames.join("")); assert.deepEqual(JSON.parse(records[0].data), payload);
  assert.equal(r.source.stats.cancel, 1); assert.equal(r.source.stats.release, 1);
  assert.equal(r.res.headers["Content-Type"], "text/event-stream; charset=utf-8");
  assert.ok(!r.res.frames.join("").includes("[DONE]"));
});

test("Azure done-event differences are not replaced by generic text requirements", () => {
  for (const n of ["response.audio.done", "response.audio.transcript.done"]) assert.equal(validateNativeEvent(n, { type: n, sequence_number: 1 }).known, true);
  const p = payloadFor("response.refusal.done"); delete p.refusal; p.text = "wrong field"; assert.throws(() => validateNativeEvent(p.type, p), { code: "invalid_native_shape" });
  const c = payloadFor("response.code_interpreter_call_code.done"); delete c.code; c.text = "wrong field"; assert.throws(() => validateNativeEvent(c.type, c), { code: "invalid_native_shape" });
  const image = payloadFor("response.image_generation_call.partial_image"); image.partial_image_b64 = false; assert.throws(() => validateNativeEvent(image.type, image), { code: "invalid_native_shape" });
  const summary = payloadFor("response.reasoning_summary_part.added"); summary.part.type = "output_text"; assert.throws(() => validateNativeEvent(summary.type, summary), { code: "invalid_native_shape" });
});
test("metadata duplicates, empty ids, comments, ignored retry values and unknown fields preserve source order", async () => {
  const data = JSON.stringify({ type: "future.v1", opaque: ["🙂", { raw: true }] });
  const text = `id: old\n:middle\nid:\nretry: nope\nretry: 0007\nunknown field: retained\nevent: future.v1\n:after-event\ndata: ${data}\n\n:second\n\n`;
  const records = await collect(parseNativeSse(fragmented(text, 1)));
  assert.equal(records[0].idPresent, true); assert.equal(records[0].id, ""); assert.equal(records[0].retry, "0007");
  assert.equal(records[1].idPresent, false); assert.equal(records[1].id, "");
  const encoded = records.map(r => encodeRecord(r)).join("");
  assert.ok(encoded.indexOf(": middle") > encoded.indexOf("id: old")); assert.ok(encoded.indexOf(": after-event") > encoded.indexOf("event: future.v1"));
  const parsed = await nativeRecords(encoded); assert.deepEqual(parsed.map(r => r.metadata), records.map(r => r.metadata)); assert.equal(parsed[0].data, data);
});
test("one-byte UTF8, leading BOM, LF CRLF and bare CR and multiline data preserve payload", async () => {
  for (const e of ["\n", "\r\n", "\r"]) {
    const text = `\uFEFF: pulse${e}event: future.v1${e}data: {"type":"future.v1",${e}data: "text":"你好🙂é"}${e}${e}`;
    const [r] = await collect(parseNativeSse(fragmented(text, 1))); assert.equal(JSON.parse(r.data).text, "你好🙂é");
  }
});
test("framing rejects invalid UTF8, NUL and forbidden controls without copying source data into errors", async () => {
  for (const [text, code] of [[Buffer.from([100,97,116,97,58,32,255,10,10]), "invalid_sse_utf8"], ["id: a\0PRIVATE\n\n", "sse_control_character"], ["data: PRIVATE\u0001\n\n", "sse_control_character"]]) {
    await assert.rejects(collect(parseNativeSse(fragmented(text))), e => { assert.equal(e.code, code); assert.equal(e.message.includes("PRIVATE"), false); return true; });
  }
  for (const text of ["event: future\ndata: {}", ": heartbeat\n", "id: 1\n", "data: {}\n"]) await assert.rejects(collect(parseNativeSse(fragmented(text))), { code: "truncated_sse_event" });
});
test("public encoder rejects unchecked metadata and fallback-field framing injection", () => {
  for (const r of [{ event: "x\ndata: injected", hasData: true, data: "{}" }, { idPresent: true, id: "x\r" }, { retry: "1\nevent: x" }, { comments: ["x\n"] }, { hasData: true, data: "x\r\ny" }, { metadata: [{ field: "id", value: "x\0" }] }, { metadata: [{ field: "a:b", value: "x" }] }]) assert.throws(() => encodeRecord(r), { code: "invalid_sse_metadata" });
});
test("wire byte counts include CRLF exactly once and exclude delimiters from the line budget", async () => {
  const text = ":x\r\n\r\n"; assert.equal(Buffer.byteLength(text), 6);
  assert.equal((await collect(parseNativeSse(fragmented(text, 1), { sseLineBytes: 2, sseEventBytes: 6, sseBufferBytes: 512 }))).length, 1);
  await assert.rejects(collect(parseNativeSse(fragmented(text, 1), { sseLineBytes: 2, sseEventBytes: 5, sseBufferBytes: 512 })), { code: "sse_event_too_large" });
});
test("line, event, framing/bookkeeping and upstream aggregate byte caps are independent", async () => {
  await assert.rejects(collect(parseNativeSse(fragmented("x".repeat(30)), { sseLineBytes: 8 })), { code: "sse_line_too_large" });
  await assert.rejects(collect(parseNativeSse(fragmented("data: a\ndata: b\n\n"), { sseEventBytes: 12 })), { code: "sse_event_too_large" });
  await assert.rejects(collect(parseNativeSse(fragmented(":x\n\n"), { sseBufferBytes: 128 })), { code: "native_sse_buffer_too_large" });
  await assert.rejects(collect(parseNativeSse(fragmented(":x\n\n".repeat(10)), { responseBytes: 12 })), { code: "response_too_large" });
  assert.equal((await collect(parseNativeSse(fragmented(":x\n\n".repeat(1200), 29)))).length, 1200);
});
test("non-progress empty chunks are bounded and malformed byte chunks fail", async () => {
  async function* empty() { for (let i = 0; i < 5; i++) yield new Uint8Array(); }
  await assert.rejects(collect(parseNativeSse(empty(), { maxEmptyChunks: 3 })), { code: "invalid_upstream_body" });
  async function* invalid() { yield "not bytes"; } await assert.rejects(collect(parseNativeSse(invalid())), { code: "invalid_upstream_body" });
});
test("future typed events remain opaque and require an actual known terminal outcome", async () => {
  const p = { type: "future.v1", sequence_number: "future opaque semantics", response: { id: "opaque" }, secret: "raw native data" };
  const r = run(frame(p) + frame(payloadFor("response.completed", 3))); await r.promise;
  assert.deepEqual(JSON.parse((await nativeRecords(r.res.frames.join("")))[0].data), p);
  const missing = run(frame(p)); await assert.rejects(missing.promise, { code: "native_relay_failed", failureCode: "missing_sse_terminal" });
  for (const data of ["{bad}", "[]", "null", "{}", '{"type":"other"}']) {
    const bad = run(`event: future.v1\ndata: ${data}\n\n`); await assert.rejects(bad.promise, { code: "native_relay_failed" }); assert.ok(!bad.res.frames.join("").includes(data));
  }
});
test("flat and nested Azure errors, failed/incomplete and observed compatibility cancellation stay native", async () => {
  const values = [payloadFor("error"), { type: "error", error: { type: "server_error", code: "busy", message: "provider explanation", param: null } }, payloadFor("response.failed"), payloadFor("response.incomplete"), payloadFor("response.cancelled")];
  for (const p of values) { const r = run(frame(p)); assert.equal((await r.promise).outcome, p.type); assert.deepEqual(JSON.parse((await nativeRecords(r.res.frames.join("")))[0].data), p); }
  for (const p of [{ type: "error", error: null }, { type: "error", error: {} }, { ...payloadFor("response.completed"), response: { id: "r", status: "failed" } }]) assert.throws(() => validateNativeEvent(p.type, p), { code: "invalid_native_shape" });
});
test("minimal flat provider errors stay known and terminal while optional metadata keeps its kind", () => {
  assert.deepEqual(validateNativeEvent("error", { type: "error", code: "busy", message: "m" }), { known: true, terminal: true, category: "error" });
  assert.deepEqual(validateNativeEvent("error", { type: "error", code: "busy", message: "m", param: null, sequence_number: 4 }), { known: true, terminal: true, category: "error" });
  for (const p of [{ type: "error", code: "busy" }, { type: "error", message: "m" }, { type: "error", code: "busy", message: "m", param: 7 }, { type: "error", code: "busy", message: "m", sequence_number: "4" }]) {
    assert.throws(() => validateNativeEvent("error", p), { code: "invalid_native_shape" }, JSON.stringify(p));
  }
});
test("created response uses real queued/in-progress statuses, never a fabricated created status", () => {
  for (const status of ["queued", "in_progress"]) assert.equal(validateNativeEvent("response.created", { ...payloadFor("response.created"), response: { id: "r", status } }).known, true);
  assert.throws(() => validateNativeEvent("response.created", { ...payloadFor("response.created"), response: { id: "r", status: "created" } }), { code: "invalid_native_shape" });
});
test("ordered sequences allow gaps, but repeats/rollback and changed response identity fail", async () => {
  const sequence = [payloadFor("response.created", 1), payloadFor("response.output_text.delta", 4), payloadFor("response.completed", 9)]; assert.equal((await run(sequence.map(p => frame(p)).join("")).promise).terminal, true);
  for (const next of [1, 0]) await assert.rejects(run(frame(payloadFor("response.created", 1)) + frame(payloadFor("response.completed", next))).promise, { failureCode: "native_sequence_order" });
  const changed = payloadFor("response.completed", 2); changed.response.id = "other";
  await assert.rejects(run(frame(payloadFor("response.created", 1)) + frame(changed)).promise, { failureCode: "native_identity_conflict" });
});
test("observed identities apply to text/annotations/summary/tool events without imposing unseen lifecycles", async () => {
  const add = payloadFor("response.output_item.added", 1);
  for (const name of ["response.output_text.delta", "response.output_text.annotation.added", "response.reasoning_summary_text.delta", "response.function_call_arguments.delta"]) {
    const p = payloadFor(name, 2); p.item_id = "wrong"; await assert.rejects(run(frame(add) + frame(p)).promise, { failureCode: "native_item_conflict" });
    assert.equal((await run(frame(p) + frame(payloadFor("response.completed", 3))).promise).terminal, true);
  }
  const duplicate = payloadFor("response.output_item.added", 2); duplicate.output_index = 1;
  await assert.rejects(run(frame(add) + frame(duplicate)).promise, { failureCode: "native_item_conflict" });
  const differentType = payloadFor("response.output_item.done", 2); differentType.item.type = "function_call";
  await assert.rejects(run(frame(add) + frame(differentType)).promise, { failureCode: "native_item_conflict" });
});
test("identity tracking has both count and byte limits and does not retain transient deltas", async () => {
  const many = Array.from({ length: 4 }, (_, i) => { const p = payloadFor("response.output_item.added", i + 1); p.output_index = i; p.item.id = `i${i}`; return frame(p); }).join("");
  await assert.rejects(run(many, { limits: { maxTrackedItems: 2 } }).promise, { failureCode: "native_tracking_limit" });
  const tracker = createNativeTracker({ sseBufferBytes: 512 });
  const p = payloadFor("response.created"); p.response.id = "x".repeat(300);
  assert.throws(() => validateRecord({ hasData: true, event: p.type, data: JSON.stringify(p) }, tracker), { code: "native_tracking_limit" });
  const transient = createNativeTracker();
  for (let i = 0; i < 5000; i++) { const v = payloadFor("response.output_text.delta", i); validateRecord({ hasData: true, data: JSON.stringify(v) }, transient); }
  assert.equal(transient.items.size, 0); assert.equal(transient.retainedBytes, 0);
});
test("parallel native calls expose partial data before terminal delivery and never execute locally", { timeout: 2000 }, async () => {
  let release, seen; const terminal = new Promise(resolve => { release = resolve; }); const emission = new Promise(resolve => { seen = resolve; });
  const a = payloadFor("response.output_item.added", 1); a.item = { id: "i0", type: "function_call", call_id: "call-0", name: "lookup", arguments: "" };
  const b = payloadFor("response.output_item.added", 2); b.output_index = 1; b.item = { ...a.item, id: "i1", call_id: "call-1" };
  const delta = payloadFor("response.function_call_arguments.delta", 3);
  const source = trackedBody(n => n === 1 ? Promise.resolve({ value: Buffer.from(frame(a) + frame(b) + frame(delta)), done: false }) : terminal);
  let executed = 0; const res = new ResponseFixture(text => { if (text.includes("function_call_arguments.delta")) seen(); return true; });
  const r = run("", { source, res, executeTool: () => { executed++; } }); await emission;
  assert.ok(res.frames.join("").includes("partial")); assert.equal(res.frames.join("").includes("response.completed"), false);
  release({ value: Buffer.from(frame(payloadFor("response.completed", 4))), done: false }); await r.promise; assert.equal(executed, 0);
});
test("a mandatory request policy denies data before emission; absent policy never acquires the reader", async () => {
  const r = run(frame(payloadFor("response.audio.delta")), { beforeEmit: () => false }); await assert.rejects(r.promise, { failureCode: "native_policy_rejected" });
  assert.equal(r.res.frames.join("").includes("response.audio.delta"), false);
  const absent = run(frame(payloadFor("response.completed")), { beforeEmit: undefined }); await assert.rejects(absent.promise, { code: "native_policy_required" }); assert.equal(absent.source.stats.reads, 0); assert.equal(absent.res.headersSent, false);
});
test("policy promises are timeout- and abort-aware with reader disposal", { timeout: 2000 }, async () => {
  const timed = run(frame(payloadFor("response.completed")), { beforeEmit: () => new Promise(() => {}), timeouts: { upstreamIdleMs: 500, downstreamStallMs: 30, policyMs: 15 } });
  await assert.rejects(timed.promise, { failureCode: "native_policy_timeout" }); assert.equal(timed.source.stats.cancel, 1); assert.equal(timed.source.stats.release, 1);
  let entered; const gate = new Promise(resolve => { entered = resolve; }); const ctl = new AbortController();
  const aborted = run(frame(payloadFor("response.completed")), { signal: ctl.signal, beforeEmit: () => { entered(); return new Promise(() => {}); } });
  await gate; ctl.abort(); await assert.rejects(aborted.promise, { code: "native_relay_failed" }); assert.ok(aborted.res.destroyed); assert.equal(aborted.source.stats.release, 1);
});
test("bridge.error is emitted once with fixed local fields, no upstream identity, payload text or Chat DONE", async () => {
  const r = run("data: PRIVATE broken\n\n"); await assert.rejects(r.promise, { failureCode: "invalid_sse_json" });
  const text = r.res.frames.join(""); const [p] = await nativeRecords(text); const data = JSON.parse(p.data);
  assert.equal(p.event, "bridge.error"); assert.equal(data.type, "bridge.error"); assert.equal(Object.hasOwn(data, "sequence_number"), false); assert.equal(Object.hasOwn(data, "response"), false);
  assert.equal((text.match(/event: bridge.error/g) || []).length, 1); assert.ok(!text.includes("PRIVATE") && !text.includes("[DONE]") && !text.includes("choices"));
  assert.equal(r.res.writableEnded, true); assert.equal(r.source.stats.cancel, 1);
  assert.equal(boundedLocalError({ code: "PRIVATE", message: "PRIVATE" }).code, "native_protocol_error");
  assert.equal(boundedLocalError({ get code() { throw new Error("PRIVATE"); } }).code, "native_protocol_error");
});
test("diagnostics exclude payloads and redact unsafe names/credentials; logging failures do not break transport", async () => {
  const infos = []; const p = { type: "future.privatekey123", data: "PRIVATE_PAYLOAD" };
  const r = run(frame(p) + frame(payloadFor("response.completed", 2)), { secrets: ["privatekey123"], onDiagnostic: info => infos.push(info) }); await r.promise;
  const log = JSON.stringify(infos); assert.ok(!log.includes("PRIVATE_PAYLOAD") && !log.includes("privatekey123")); assert.equal(infos[0].eventName, "<redacted_event>");
  const failedLog = run(frame(payloadFor("response.completed")), { onDiagnostic: () => Promise.reject(new Error("PRIVATE")) }); await failedLog.promise;
});
test("provider error redaction changes only known message fields and keeps metadata and opaque state", async () => {
  const secret = "synthetic-secret-marker";
  for (const p of [payloadFor("error"), { type: "error", error: { message: secret, code: "busy" } }, payloadFor("response.failed")]) {
    if (p.type === "error" && !p.error) p.message = secret;
    if (p.response) p.response.error = { code: "busy", message: secret };
    p.opaque = { text: secret };
    const raw = `id: retained\n: comment\nevent: ${p.type}\ndata: ${JSON.stringify(p)}\n\n`;
    const r = run(raw, { secrets: [secret] }); await r.promise;
    const [record] = await nativeRecords(r.res.frames.join("")); const got = JSON.parse(record.data);
    const detail = p.type === "error" ? (got.error || got) : got.response.error;
    assert.equal(detail.message, "[redacted]"); assert.equal(got.opaque.text, secret); assert.equal(record.id, "retained"); assert.equal(record.comments[0], "comment");
    assert.equal((p.type === "error" ? (p.error || p) : p.response.error).message, secret);
  }
});
test("completed item reuse and malformed optional logprobs remain visible failures", async () => {
  const add = payloadFor("response.output_item.added", 1), done = payloadFor("response.output_item.done", 2);
  const again = payloadFor("response.output_item.done", 3);
  await assert.rejects(run(frame(add) + frame(done) + frame(again)).promise, { failureCode: "native_item_conflict" });
  const p = payloadFor("response.output_text.delta"); p.logprobs = {};
  assert.throws(() => validateNativeEvent(p.type, p), { code: "invalid_native_shape" });
  delete p.logprobs; assert.equal(validateNativeEvent(p.type, p).known, true);
});
test("unknown future output item types are preserved without inventing an identity", async () => {
  const p = payloadFor("response.output_item.added"); p.item = { type: "future_item", opaque: [1, 2] };
  const r = run(frame(p) + frame(payloadFor("response.completed", 2))); await r.promise;
  assert.deepEqual(JSON.parse((await nativeRecords(r.res.frames.join("")))[0].data).item, p.item);
});
test("unknown extension fields on known events are preserved without guessed schema interpretation", async () => {
  const p = payloadFor("response.audio.delta"); p.part = null; p.item_id = "opaque"; p.output_index = 123; p.response = { error: { message: "synthetic-secret-marker" } };
  const r = run(frame(p) + frame(payloadFor("response.completed", 2)), { secrets: ["synthetic-secret-marker"] }); await r.promise;
  assert.deepEqual(JSON.parse((await nativeRecords(r.res.frames.join("")))[0].data), p);
});
test("future item identity can appear only at completion without fabricating or losing native payload", async () => {
  const add = payloadFor("response.output_item.added", 1); add.item = { type: "future_item" };
  const done = payloadFor("response.output_item.done", 2); done.item = { type: "future_item", id: "later" };
  const r = run(frame(add) + frame(done) + frame(payloadFor("response.completed", 3))); await r.promise;
  const records = await nativeRecords(r.res.frames.join("")); assert.deepEqual(JSON.parse(records[0].data).item, add.item); assert.deepEqual(JSON.parse(records[1].data).item, done.item);
});
test("upstream idle, abort, downstream stall, byte exhaustion and nonblocking failure cleanup are bounded", { timeout: 2500 }, async () => {
  const pending = trackedBody(() => new Promise(() => {})); const r = run("", { source: pending, timeouts: { upstreamIdleMs: 15, downstreamStallMs: 30, policyMs: 100 } }); await assert.rejects(r.promise, { failureCode: "upstream_idle_timeout" }); assert.equal(pending.stats.cancel, 1); assert.equal(pending.stats.release, 1);
  const ctl = new AbortController(); const source = trackedBody(() => new Promise(() => {})); const abort = run("", { source, signal: ctl.signal }); ctl.abort(); await assert.rejects(abort.promise); assert.ok(abort.res.destroyed);
  const stuck = run(frame(payloadFor("response.completed")), { res: new ResponseFixture(() => false) }); await assert.rejects(stuck.promise, { failureCode: "downstream_stall_timeout" }); assert.ok(stuck.res.destroyed); assert.equal(stuck.res.listenerCount("drain"), 0); assert.equal(stuck.res.listenerCount("close"), 0);
  const small = run(frame(payloadFor("response.completed")), { limits: { downstreamBytes: 10 } }); await assert.rejects(small.promise, { failureCode: "downstream_response_too_large" }); assert.ok(small.res.destroyed);
});
test("downstream drain pauses upstream consumption and then finishes cleanly", { timeout: 2000 }, async () => {
  let blocked; const gate = new Promise(resolve => { blocked = resolve; });
  const res = new ResponseFixture((text, count) => { if (count === 1) { blocked(); return false; } return true; });
  const r = run(frame({ type: "future.v1" }) + frame(payloadFor("response.completed", 2)), { res, step: 512 });
  await gate; assert.equal(r.source.stats.reads, 1); res.writableNeedDrain = false; res.emit("drain"); await r.promise; assert.ok(res.writableEnded);
});
test("imports have no environment, fixture, listener or logging effects", () => {
  const sources = ["native-events.js", "native-sse.js"].map(file => [file, fs.readFileSync(file, "utf8")]);
  const originalCreate = http.createServer, originalLoad = process.loadEnvFile, originalLog = console.log;
  const effects = [];
  http.createServer = () => { effects.push("listener"); throw new Error("Forbidden"); };
  process.loadEnvFile = () => { effects.push("env"); throw new Error("Forbidden"); };
  console.log = () => { effects.push("log"); };
  try {
    for (const [file, text] of sources) {
      const module = { exports: {} };
      const localRequire = name => { if (name === "./native-events") return eventsModule; if (name === "./sse") return require("./sse"); effects.push(`import:${name}`); throw new Error("Unexpected import"); };
      vm.runInThisContext(`(function(require,module,exports){${text}\n})`, { filename: file })(localRequire, module, module.exports);
      assert.ok(Object.keys(module.exports).length > 0);
    }
    assert.deepEqual(effects, []);
  } finally { http.createServer = originalCreate; process.loadEnvFile = originalLoad; console.log = originalLog; }
});

test("function_call_arguments.done does not require a tool name the provider never sends", () => {
  const payload = { type: "response.function_call_arguments.done", item_id: "fc_1", output_index: 0, sequence_number: 4, arguments: "{}" };
  const shape = validateNativeEvent(payload.type, payload);
  assert.deepEqual(shape, { known: true, terminal: false, category: "function-tool" });
  // A provider that does include the name must still satisfy the declared type.
  assert.equal(validateNativeEvent(payload.type, { ...payload, name: "probe_a" }).known, true);
  assert.throws(() => validateNativeEvent(payload.type, { ...payload, name: null }), { code: "invalid_native_shape" });
  // arguments stays required.
  const { arguments: _omitted, ...withoutArguments } = payload;
  assert.throws(() => validateNativeEvent(payload.type, withoutArguments), { code: "invalid_native_shape" });
});
