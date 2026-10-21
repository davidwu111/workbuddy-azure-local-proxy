"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EventEmitter } = require("node:events");
const { transportError, waitWithTimeout, waitForDrain, readChunks, readBoundedBody, parseSse, SseWriter, streamResponse } = require("./sse");
const limits = { sseLineBytes: 4 * 1024 * 1024, sseEventBytes: 4 * 1024 * 1024, sseBufferBytes: 4 * 1024 * 1024, responseBytes: 8 * 1024 * 1024 };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function* fragmented(value, step = 7) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  for (let i = 0; i < bytes.length; i += step) yield bytes.subarray(i, i + step);
}
async function collect(iterable) { const result = []; for await (const value of iterable) result.push(value); return result; }
function trackedBody(read) {
  const stats = { cancelled: 0, released: 0, reads: 0 };
  const reader = { read() { stats.reads++; return read(stats.reads); }, cancel() { stats.cancelled++; return Promise.resolve(); }, releaseLock() { stats.released++; } };
  return { stats, body: { getReader() { return reader; } } };
}
class FakeResponse extends EventEmitter {
  constructor(writeResult = true) { super(); this.writeResult = writeResult; this.frames = []; this.destroyed = false; this.writableEnded = false; this.headersSent = false; }
  writeHead(status, headers) { this.statusCode = status; this.headers = headers; this.headersSent = true; }
  flushHeaders() {}
  write(frame) { this.frames.push(frame); return typeof this.writeResult === "function" ? this.writeResult(frame, this.frames.length) : this.writeResult; }
  end() { this.writableEnded = true; }
  destroy() { this.destroyed = true; this.emit("close"); }
}

test("SSE parser supports fragmented UTF-8, BOM, LF, CRLF, CR and data-only records", async () => {
  for (const ending of ["\n", "\r\n", "\r"]) {
    const text = `\uFEFF: comment${ending}event: response.output_text.delta${ending}data: {"type":"response.output_text.delta","delta":"你好🙂"}${ending}${ending}data: {"type":"response.completed","response":{"status":"completed","output":[]}}${ending}${ending}`;
    const events = await collect(parseSse(fragmented(text, 1), limits));
    assert.equal(events.length, 2); assert.equal(events[0].event, "response.output_text.delta");
    assert.equal(JSON.parse(events[0].data).delta, "你好🙂"); assert.equal(events[1].event, "");
  }
});

test("SSE multiline data/comments/empty metadata are deliberate and limits reset per event", async () => {
  const events = await collect(parseSse(fragmented(':ignored\ndata: {"a":\ndata: 1}\n\nid: 1\nretry: 10\n\ndata: two\n\n', 3), limits));
  assert.deepEqual(events, [{ event: "", data: '{"a":\n1}' }, { event: "", data: "two" }]);
  const frames = Array.from({ length: 20 }, () => 'data: "1234567890"\n\n').join("");
  assert.equal((await collect(parseSse(fragmented(frames), { ...limits, sseEventBytes: 30, sseBufferBytes: 30 }))).length, 20);
});

test("parser rejects unfinished lines/events, invalid UTF-8 and separate bounded resources", async () => {
  for (const text of ['data: {"x":1}', 'event: response.completed\ndata: {}\n']) {
    await assert.rejects(collect(parseSse(fragmented(text), limits)), { code: "truncated_sse_event" });
  }
  await assert.rejects(collect(parseSse(fragmented(Buffer.from([100, 97, 116, 97, 58, 32, 255, 10, 10])), limits)), { code: "invalid_sse_utf8" });
  await assert.rejects(collect(parseSse(fragmented("data: " + "x".repeat(100), 9), { ...limits, sseLineBytes: 20 })), { code: "sse_line_too_large" });
  const multiline = "data: 123456\ndata: 123456\n\n";
  await assert.rejects(collect(parseSse(fragmented(multiline), { ...limits, sseEventBytes: 20 })), { code: "sse_event_too_large" });
  await assert.rejects(collect(parseSse(fragmented(multiline), { ...limits, sseBufferBytes: 20 })), { code: "sse_buffer_too_large" });
});

test("CRLF bytes count toward event budget instead of being silently discounted", async () => {
  const text = "data:x\r\ndata:y\r\n\r\n";
  await assert.rejects(collect(parseSse(fragmented(text, 1), { ...limits, sseEventBytes: 15 })), { code: "sse_event_too_large" });
});

test("readers enforce byte limits and release/cancel on every successful or failed exit", async () => {
  const valid = trackedBody(n => Promise.resolve(n === 1 ? { value: Buffer.from("hello"), done: false } : { done: true }));
  assert.equal(await readBoundedBody(valid.body, { idleMs: 100, maxBytes: 5 }), "hello");
  assert.deepEqual(valid.stats, { cancelled: 1, released: 1, reads: 2 });
  const large = trackedBody(() => Promise.resolve({ value: Buffer.alloc(6), done: false }));
  await assert.rejects(readBoundedBody(large.body, { idleMs: 100, maxBytes: 5 }), { code: "response_too_large" });
  assert.equal(large.stats.cancelled, 1); assert.equal(large.stats.released, 1);
  const corrupt = trackedBody(n => Promise.resolve(n === 1 ? { value: Buffer.from([255]), done: false } : { done: true }));
  await assert.rejects(readBoundedBody(corrupt.body, { idleMs: 100, maxBytes: 5 }), { code: "invalid_upstream_utf8" });
  assert.equal(corrupt.stats.released, 1);
});

test("reader idle and cancellation terminate pending reads and clean up", { timeout: 1000 }, async () => {
  const stalled = trackedBody(() => new Promise(() => {}));
  await assert.rejects(readBoundedBody(stalled.body, { idleMs: 20, maxBytes: 10 }), { code: "upstream_idle_timeout" });
  assert.equal(stalled.stats.cancelled, 1); assert.equal(stalled.stats.released, 1);
  const controller = new AbortController(); const cancelled = trackedBody(() => new Promise(() => {}));
  const work = readBoundedBody(cancelled.body, { signal: controller.signal, idleMs: 500, maxBytes: 10 });
  controller.abort(transportError("client_cancelled", "Synthetic client disconnect", 499));
  await assert.rejects(work, { code: "client_cancelled" });
  assert.equal(cancelled.stats.cancelled, 1); assert.equal(cancelled.stats.released, 1);
});

test("upstream idle clock is paused while the consumer is intentionally backpressured", { timeout: 1000 }, async () => {
  const fixture = trackedBody(n => Promise.resolve(n < 3 ? { value: Buffer.from("x"), done: false } : { done: true }));
  const iterator = readChunks(fixture.body, { idleMs: 20, maxBytes: 10 });
  assert.equal((await iterator.next()).value.toString(), "x");
  await delay(60);
  assert.equal((await iterator.next()).value.toString(), "x");
  assert.equal((await iterator.next()).done, true);
  assert.equal(fixture.stats.released, 1);
});

test("timeout wait handles abort before and during wait without hanging", { timeout: 1000 }, async () => {
  const controller = new AbortController();
  const work = waitWithTimeout(new Promise(() => {}), { signal: controller.signal, timeoutMs: 500 });
  controller.abort(transportError("client_cancelled", "Synthetic abort", 499));
  await assert.rejects(work, { code: "client_cancelled" });
  await assert.rejects(waitWithTimeout(Promise.resolve(1), { signal: controller.signal, timeoutMs: 500 }), { code: "client_cancelled" });
});

test("drain waits are timeout/abort/close aware and remove every event listener", { timeout: 1000 }, async () => {
  for (const scenario of ["drain", "close", "abort", "timeout"]) {
    const res = new FakeResponse(); const controller = new AbortController();
    const work = waitForDrain(res, { signal: controller.signal, timeoutMs: 20 });
    if (scenario === "drain") res.emit("drain");
    if (scenario === "close") res.destroy();
    if (scenario === "abort") controller.abort(transportError("client_cancelled", "Synthetic abort", 499));
    if (scenario === "drain") await work;
    else await assert.rejects(work, { code: scenario === "timeout" ? "downstream_stall_timeout" : "client_cancelled" });
    for (const event of ["drain", "close", "error"]) assert.equal(res.listenerCount(event), 0);
  }
});

test("writer sends exactly one DONE and respects bounded drain pressure", async () => {
  const res = new FakeResponse(); const writer = new SseWriter(res, { stallMs: 100 });
  writer.start(); await writer.emit({ choices: [{ delta: { content: "hello" } }] });
  await writer.finish([{ choices: [{ delta: {}, finish_reason: "stop" }] }]);
  await writer.finish([]); await writer.fail({ error: { message: "ignored" } });
  assert.equal(res.statusCode, 200); assert.equal(res.writableEnded, true);
  assert.equal(res.frames.join("").split("data: [DONE]").length - 1, 1);
});

test("failed terminal-frame drainage cannot leave a live response after finish starts", { timeout: 1000 }, async () => {
  const res = new FakeResponse(false); const writer = new SseWriter(res, { stallMs: 20 }); writer.start();
  await assert.rejects(writer.finish([]), { code: "downstream_stall_timeout" });
  assert.ok(res.destroyed || res.writableEnded, "failed terminal delivery must close/destroy the response");
  assert.equal(res.listenerCount("drain"), 0);
});

test("tool identity and argument data remain hidden while waiting for terminal validation", { timeout: 1000 }, async () => {
  let release, entered; const gate = new Promise(resolve => { entered = resolve; }); const terminal = new Promise(resolve => { release = resolve; });
  const call = { type: "function_call", id: "item_1", call_id: "call_1", name: "lookup", arguments: "{}", status: "completed" };
  const event = (name, value) => `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
  const first = event("response.output_item.added", { output_index: 0, item: { ...call, status: "in_progress", arguments: "" } }) + event("response.function_call_arguments.delta", { output_index: 0, item_id: "item_1", delta: "{}" });
  const tracked = trackedBody(n => { if (n === 1) return Promise.resolve({ value: Buffer.from(first), done: false }); entered(); return terminal; });
  const res = new FakeResponse(); const writer = new SseWriter(res, { stallMs: 100 }); writer.start();
  const work = streamResponse({ body: tracked.body }, writer, { alias: "local", limits, timeouts: { upstreamIdleMs: 500 }, includeUsage: false });
  await gate; assert.equal(res.frames.join("").includes("lookup"), false); assert.equal(res.frames.join("").includes("call_1"), false);
  release({ value: Buffer.from(event("response.completed", { response: { status: "completed", output: [call] } })), done: false });
  await work; assert.equal(res.frames.join("").includes("lookup"), true); assert.equal(tracked.stats.cancelled, 1); assert.equal(tracked.stats.released, 1);
});

test("encoded output bytes and aggregate retained items have independent hard caps", { timeout: 1000 }, async () => {
  const res = new FakeResponse(); const writer = new SseWriter(res, { stallMs: 100, maxBytes: 40 }); writer.start();
  await assert.rejects(writer.emit({ content: "x".repeat(100) }), { code: "downstream_response_too_large" });
  assert.equal(res.frames.length, 0); await writer.fail({ error: { message: "bounded error" } }); assert.equal(res.destroyed, true);
  const event = (index, id) => `event: response.output_item.added\ndata: ${JSON.stringify({ output_index: index, item: { type: "function_call", id, call_id: id, name: "lookup", arguments: JSON.stringify({ key: "x".repeat(500) }) } })}\n\n`;
  const tracked = trackedBody(n => Promise.resolve(n === 1 ? { value: Buffer.from(event(0, "call_1") + event(1, "call_2")), done: false } : { done: true }));
  await assert.rejects(streamResponse({ body: tracked.body }, new SseWriter(new FakeResponse(), { stallMs: 100 }), { alias: "local", limits: { ...limits, sseBufferBytes: 1000 }, timeouts: { upstreamIdleMs: 100 } }), { code: "sse_buffer_too_large" });
  assert.equal(tracked.stats.cancelled, 1); assert.equal(tracked.stats.released, 1);
});

test("abort during terminal drainage immediately cleans up and destroys instead of reopening a wait", { timeout: 1000 }, async () => {
  const controller = new AbortController(); const res = new FakeResponse(false); const writer = new SseWriter(res, { signal: controller.signal, stallMs: 500 }); writer.start();
  const work = writer.finish([]); controller.abort(transportError("client_cancelled", "Synthetic abort", 499));
  await assert.rejects(work, { code: "client_cancelled" }); assert.equal(res.destroyed, true);
  for (const name of ["drain", "close", "error"]) assert.equal(res.listenerCount(name), 0);
});

module.exports = { FakeResponse, fragmented, collect, limits, trackedBody };
