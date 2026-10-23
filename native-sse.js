"use strict";

const { transportError, ByteStore, readChunks, waitForDrain, waitWithTimeout } = require("./sse");
const { EVENT_REGISTRY, COMPATIBILITY_EVENTS, validateNativeEvent } = require("./native-events");
const DEFAULT_LIMITS = Object.freeze({ responseBytes: 16 * 1024 ** 2, sseLineBytes: 256 * 1024, sseEventBytes: 1024 ** 2, sseBufferBytes: 2 * 1024 ** 2, downstreamBytes: 16 * 1024 ** 2, maxTrackedItems: 4096, maxEmptyChunks: 1024 });
const DEFAULT_TIMEOUTS = Object.freeze({ upstreamIdleMs: 300000, downstreamStallMs: 30000, policyMs: 30000 });
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const controls = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const fail = (code, message) => { throw transportError(code, message); };
function settings(defaults, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Native transport settings must be an object");
  const out = {};
  for (const key of Object.keys(defaults)) {
    const value = own(input, key) ? input[key] : defaults[key];
    if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`Invalid native transport setting: ${key}`);
    out[key] = value;
  }
  return out;
}
function decode(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { fail("invalid_sse_utf8", "Native SSE contains invalid UTF-8"); }
}
function safeLine(value) { return typeof value === "string" && !/[\r\n]/.test(value) && !controls.test(value); }

async function* parseNativeSse(chunks, inputLimits = {}) {
  const limits = settings(DEFAULT_LIMITS, inputLimits);
  const store = new ByteStore(limits.sseLineBytes);
  let eventBytes = 0, retained = 0, total = 0, emptyChunks = 0, pendingCR = false, first = true;
  let metadata = [], dataLines = [], comments = [], event = "", id = "", idPresent = false, retry, hasData = false;
  const check = added => {
    if (store.size + added > limits.sseLineBytes) fail("sse_line_too_large", "Native SSE line exceeds configured limit");
    if (eventBytes + store.size + added > limits.sseEventBytes) fail("sse_event_too_large", "Native SSE event exceeds configured limit");
    if (eventBytes + store.size + added > limits.sseBufferBytes) fail("native_sse_buffer_too_large", "Native SSE framing exceeds configured limit");
  };
  const append = bytes => { check(bytes.byteLength); store.append(bytes); };
  const line = delimiter => {
    const rawSize = store.size + delimiter;
    if (eventBytes + rawSize > limits.sseEventBytes) fail("sse_event_too_large", "Native SSE event exceeds configured limit");
    if (eventBytes + rawSize > limits.sseBufferBytes) fail("native_sse_buffer_too_large", "Native SSE framing exceeds configured limit");
    let text = decode(store.take());
    if (first) { first = false; if (text.startsWith("\uFEFF")) text = text.slice(1); }
    if (controls.test(text)) fail("sse_control_character", "Native SSE line contains forbidden controls");
    eventBytes += rawSize;
    if (!text) {
      const result = metadata.length ? Object.freeze({ event, id, idPresent, retry, data: hasData ? dataLines.join("\n") : undefined, hasData, comments: Object.freeze(comments), metadata: Object.freeze(metadata) }) : null;
      metadata = []; dataLines = []; comments = []; event = ""; id = ""; idPresent = false; retry = undefined; hasData = false; eventBytes = 0; retained = 0;
      return result;
    }
    // Account for per-field bookkeeping as well as wire bytes; tiny fields cannot grow an unbounded array.
    retained += 128 + 2 * text.length;
    if (retained > limits.sseBufferBytes) fail("native_sse_buffer_too_large", "Native SSE retained metadata exceeds configured limit");
    if (text.startsWith(":")) {
      const value = text.slice(1).replace(/^ /, "");
      comments.push(value); metadata.push(Object.freeze({ field: ":", value })); return null;
    }
    const colon = text.indexOf(":"), field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1); if (value.startsWith(" ")) value = value.slice(1);
    metadata.push(Object.freeze({ field, value }));
    if (field === "data") { hasData = true; dataLines.push(value); }
    else if (field === "event") event = value;
    else if (field === "id") { id = value; idPresent = true; }
    else if (field === "retry" && /^[0-9]+$/.test(value)) retry = value;
    return null;
  };
  for await (const chunk of chunks) {
    if (!(chunk instanceof Uint8Array)) fail("invalid_upstream_body", "Native upstream body must contain bytes");
    total += chunk.byteLength;
    if (total > limits.responseBytes) fail("response_too_large", "Native upstream body exceeds configured byte limit");
    if (!chunk.byteLength) { if (++emptyChunks > limits.maxEmptyChunks) fail("invalid_upstream_body", "Native upstream body made no byte progress"); continue; }
    emptyChunks = 0; let start = 0;
    if (pendingCR) { pendingCR = false; const lf = chunk[0] === 10; const result = line(lf ? 2 : 1); if (lf) start = 1; if (result) yield result; }
    for (let i = start; i < chunk.byteLength; i++) {
      if (chunk[i] !== 10 && chunk[i] !== 13) continue;
      if (i > start) append(chunk.subarray(start, i));
      if (chunk[i] === 13 && i + 1 === chunk.byteLength) { pendingCR = true; start = i + 1; break; }
      const crlf = chunk[i] === 13 && chunk[i + 1] === 10;
      const result = line(crlf ? 2 : 1); if (crlf) i++; start = i + 1; if (result) yield result;
    }
    if (start < chunk.byteLength) append(chunk.subarray(start));
  }
  if (pendingCR) { const result = line(1); if (result) yield result; }
  if (store.size || eventBytes || metadata.length) fail("truncated_sse_event", "Native SSE ended inside an event");
}

function createNativeTracker(inputLimits = {}) {
  const limits = settings(DEFAULT_LIMITS, inputLimits);
  return { sequence: undefined, responseId: undefined, items: new Map(), identities: new Map(), retainedBytes: 0, maxItems: limits.maxTrackedItems, maxBytes: limits.sseBufferBytes };
}
function retain(tracker, amount) {
  if (tracker.retainedBytes + amount > tracker.maxBytes) fail("native_tracking_limit", "Native identity tracking exceeds configured byte limit");
  tracker.retainedBytes += amount;
}
function validateRecord(record, tracker) {
  if (!record.hasData) return { ...record, known: false, terminal: false };
  let payload; try { payload = JSON.parse(record.data); } catch { fail("invalid_sse_json", "Native SSE data is not valid JSON"); }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) fail("invalid_native_payload", "Native SSE data must be a typed object");
  const name = record.event || payload.type;
  if (record.event && payload.type !== record.event) fail("native_event_conflict", "Native event and payload type conflict");
  const shape = validateNativeEvent(name, payload);
  if (!shape.known) return { ...record, name, payload, known: false, terminal: false };
  if (own(payload, "sequence_number")) {
    if (tracker.sequence !== undefined && payload.sequence_number <= tracker.sequence) fail("native_sequence_order", "Native sequence numbers are out of order");
    tracker.sequence = payload.sequence_number;
  }
  const entry = EVENT_REGISTRY[name] || COMPATIBILITY_EVENTS[name];
  if (entry.category.startsWith("lifecycle") || name === "response.cancelled") {
    const responseId = payload.response.id;
    if (tracker.responseId !== undefined && tracker.responseId !== responseId) fail("native_identity_conflict", "Native response identity conflicts");
    if (tracker.responseId === undefined) { retain(tracker, 256 + 2 * responseId.length); tracker.responseId = responseId; }
  }
  if (name === "error" && tracker.responseId !== undefined && own(payload, "response_id") && payload.response_id !== tracker.responseId) fail("native_identity_conflict", "Native response identity conflicts");
  if (entry.category === "output-item-lifecycle") {
    const index = payload.output_index, item = payload.item, id = typeof item.id === "string" ? item.id : undefined;
    const old = tracker.items.get(index);
    if (old) {
      if (name === "response.output_item.added" || old.done || old.type !== item.type || (old.id !== undefined && id !== undefined && old.id !== id)) fail("native_item_conflict", "Native output item lifecycle conflicts");
      if (old.id === undefined && id !== undefined) {
        if (tracker.identities.has(id)) fail("native_item_conflict", "Native output item identity is repeated");
        retain(tracker, 2 * id.length); old.id = id; tracker.identities.set(id, index);
      }
      old.done = true;
    } else {
      if (tracker.items.size >= tracker.maxItems) fail("native_tracking_limit", "Native observed item count exceeds configured limit");
      if (id !== undefined && tracker.identities.has(id)) fail("native_item_conflict", "Native output item identity is repeated");
      retain(tracker, 256 + 2 * (item.type.length + (id?.length || 0)));
      tracker.items.set(index, { id, type: item.type, done: name === "response.output_item.done" });
      if (id !== undefined) tracker.identities.set(id, index);
    }
  } else if (own(entry.fields, "output_index") && own(entry.fields, "item_id")) {
    const observed = tracker.items.get(payload.output_index);
    if (observed && observed.id !== undefined && observed.id !== payload.item_id) fail("native_item_conflict", "Native event item identity conflicts");
    // Do not impose a universal part/delta ordering; only compare identities actually observed.
  }
  return { ...record, name, payload, known: true, terminal: shape.terminal };
}

function encodeRecord(record, maxBytes = DEFAULT_LIMITS.downstreamBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("Invalid native output byte budget");
  const out = []; let size = 0;
  const add = text => { size += Buffer.byteLength(text); if (size > maxBytes) fail("downstream_response_too_large", "Native downstream response exceeds configured limit"); out.push(text); };
  const field = (name, value) => {
    if (!safeLine(name) || !safeLine(value) || (name !== ":" && (!name || name.includes(":")))) fail("invalid_sse_metadata", "Native SSE metadata cannot be safely emitted");
    if (name === ":") add(`:${value ? ` ${value}` : ""}\n`);
    else add(`${name}: ${value}\n`);
  };
  if (Array.isArray(record.metadata) && record.metadata.length) {
    for (const meta of record.metadata) field(meta.field, meta.value);
  } else {
    for (const comment of record.comments || []) field(":", comment);
    if (record.event !== undefined && record.event !== "") field("event", record.event);
    if (record.idPresent) field("id", record.id);
    if (record.retry !== undefined) { if (typeof record.retry !== "string" || !/^[0-9]+$/.test(record.retry)) fail("invalid_sse_metadata", "Native SSE retry value is invalid"); field("retry", record.retry); }
    if (record.hasData) {
      if (typeof record.data !== "string") fail("invalid_native_payload", "Native SSE data must be text");
      for (const text of record.data.split("\n")) field("data", text);
    }
  }
  add("\n"); return out.join("");
}
const ERROR_MESSAGES = Object.freeze(Object.assign(Object.create(null), {
  native_protocol_error: "The native stream could not be safely relayed.", invalid_native_shape: "The native event shape was invalid.", invalid_native_payload: "The native event payload was invalid.", invalid_sse_metadata: "The native SSE metadata was invalid.", native_event_conflict: "The native event type conflicted with its payload.",
  native_identity_conflict: "The native stream contained conflicting response identities.", native_item_conflict: "The native stream contained conflicting item identities.", native_sequence_order: "The native stream sequence was invalid.", native_tracking_limit: "The native stream exceeded its identity tracking limit.",
  native_policy_rejected: "The native event was denied by request policy.", native_policy_required: "The native request policy is missing.", native_policy_timeout: "The native request policy timed out.",
  response_too_large: "The native stream exceeded its upstream byte limit.", sse_line_too_large: "The native stream exceeded its line limit.", sse_event_too_large: "The native stream exceeded its event limit.", native_sse_buffer_too_large: "The native stream exceeded its framing budget.",
  invalid_sse_utf8: "The native stream contained invalid UTF-8.", sse_control_character: "The native stream contained invalid control characters.", invalid_sse_json: "The native stream contained invalid JSON.", invalid_upstream_body: "The native upstream body was invalid.", truncated_sse_event: "The native stream ended mid-event.", missing_sse_terminal: "The native stream ended without a terminal event.",
  upstream_idle_timeout: "The native upstream stream timed out.", downstream_stall_timeout: "The downstream client stopped accepting data.", downstream_response_too_large: "The native response exceeded its downstream byte limit.", client_cancelled: "The client disconnected.", total_timeout: "The native request lifetime expired.", shutting_down: "The bridge is shutting down.",
}));
function boundedLocalError(error) {
  let input; try { input = error?.code; } catch {}
  const code = typeof input === "string" && own(ERROR_MESSAGES, input) ? input : "native_protocol_error";
  return { code, message: ERROR_MESSAGES[code] };
}
class NativeSseWriter {
  constructor(res, { signal, stallMs = DEFAULT_TIMEOUTS.downstreamStallMs, maxBytes = DEFAULT_LIMITS.downstreamBytes } = {}) {
    if (!Number.isSafeInteger(stallMs) || stallMs <= 0 || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("Invalid native writer budget");
    this.res = res; this.signal = signal; this.stallMs = stallMs; this.maxBytes = maxBytes; this.bytes = 0; this.closed = false; this.started = false;
  }
  start() {
    if (this.started) return; this.started = true;
    if (!this.res.headersSent) { this.res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }); this.res.flushHeaders?.(); }
  }
  async emit(record) {
    if (this.closed || this.res.destroyed || this.res.writableEnded) throw transportError("client_cancelled", "Downstream client disconnected", 499);
    if (this.signal?.aborted) throw this.signal.reason;
    const frame = encodeRecord(record, this.maxBytes - this.bytes); this.bytes += Buffer.byteLength(frame);
    if (!this.res.write(frame)) await waitForDrain(this.res, { signal: this.signal, timeoutMs: this.stallMs });
  }
  end() { if (!this.closed) { this.res.end(); this.closed = true; } }
  destroy() { this.closed = true; if (!this.res.destroyed) this.res.destroy(); }
  async bridgeError(error) {
    if (this.closed || this.res.destroyed || this.res.writableEnded) return false;
    const local = boundedLocalError(error); this.closed = true;
    if (this.signal?.aborted || this.res.writableNeedDrain || ["downstream_stall_timeout", "client_cancelled", "shutting_down"].includes(local.code)) { this.res.destroy(); return false; }
    try {
      const frame = encodeRecord({ event: "bridge.error", hasData: true, data: JSON.stringify({ type: "bridge.error", error: local }) }, this.maxBytes - this.bytes);
      this.bytes += Buffer.byteLength(frame);
      if (!this.res.write(frame)) { this.res.destroy(); return false; }
      this.res.end(); return true;
    } catch { this.res.destroy(); return false; }
  }
}
function redactNativeErrorRecord(record, secrets = []) {
  if (!record.known || !Array.isArray(secrets)) return record;
  const entry = EVENT_REGISTRY[record.name] || COMPATIBILITY_EVENTS[record.name];
  if (record.name !== "error" && !own(entry.fields, "response")) return record;
  const values = secrets.filter(value => typeof value === "string" && value.length >= 8);
  const payload = record.payload;
  const nested = record.name === "error" && payload.error && typeof payload.error === "object";
  const detail = record.name === "error" ? (nested ? payload.error : payload) : payload.response?.error;
  if (!detail || typeof detail.message !== "string") return record;
  let message = detail.message;
  for (const value of values) message = message.split(value).join("[redacted]");
  if (message === detail.message) return record;
  const next = record.name === "error" ? (nested ? { ...payload, error: { ...detail, message } } : { ...payload, message }) : { ...payload, response: { ...payload.response, error: { ...detail, message } } };
  const data = JSON.stringify(next); let replaced = false;
  const metadata = record.metadata?.flatMap(meta => {
    if (meta.field !== "data") return [meta];
    if (replaced) return []; replaced = true; return [Object.freeze({ field: "data", value: data })];
  });
  return { ...record, payload: next, data, ...(metadata ? { metadata: Object.freeze(metadata) } : {}) };
}
function diagnosticName(name, secrets = []) {
  if (typeof name !== "string" || !/^[a-z][a-z0-9_.-]{0,127}$/.test(name) || secrets.some(s => typeof s === "string" && s.length >= 8 && name.includes(s))) return "<redacted_event>";
  return name;
}
function diagnostic(callback, info) {
  if (typeof callback !== "function") return;
  try { const result = callback(Object.freeze(info)); if (result && typeof result.then === "function") Promise.resolve(result).catch(() => {}); } catch {}
}
async function relayNativeSse(upstream, res, options = {}) {
  const limits = settings(DEFAULT_LIMITS, options.limits), timeouts = settings(DEFAULT_TIMEOUTS, options.timeouts);
  if (typeof options.beforeEmit !== "function") fail("native_policy_required", "A request-scoped native policy is required");
  const signal = options.signal, writer = options.writer || new NativeSseWriter(res, { signal, stallMs: timeouts.downstreamStallMs, maxBytes: limits.downstreamBytes });
  const tracker = createNativeTracker(limits); let emitted = 0;
  try {
    if (signal?.aborted) throw signal.reason;
    writer.start();
    for await (const raw of parseNativeSse(readChunks(upstream?.body, { signal, idleMs: timeouts.upstreamIdleMs, maxBytes: limits.responseBytes }), limits)) {
      if (!raw.hasData) { await writer.emit(raw); emitted++; continue; }
      const record = validateRecord(raw, tracker);
      const entry = EVENT_REGISTRY[record.name] || COMPATIBILITY_EVENTS[record.name];
      const info = Object.freeze({ name: record.name, known: record.known, category: entry?.category || "unknown", featureGated: entry?.featureGated === true });
      const allowed = await waitWithTimeout(Promise.resolve().then(() => options.beforeEmit(info, record.payload)), { signal, timeoutMs: timeouts.policyMs, code: "native_policy_timeout" });
      if (allowed !== true) fail("native_policy_rejected", "Native event was denied by request policy");
      diagnostic(options.onDiagnostic, { eventName: diagnosticName(record.name, options.secrets), known: record.known, category: info.category });
      await writer.emit(redactNativeErrorRecord(record, options.secrets)); emitted++;
      if (record.terminal) { writer.end(); return { outcome: record.name, terminal: true, emitted, bytesOut: writer.bytes, terminalPayload: record.payload }; }
    }
    fail("missing_sse_terminal", "Native SSE ended without a terminal event");
  } catch (error) {
    const local = boundedLocalError(error);
    diagnostic(options.onDiagnostic, { code: local.code });
    try { if (!writer.closed) await writer.bridgeError(error); } catch { writer.destroy(); }
    throw Object.assign(transportError("native_relay_failed", "Native relay failed after applying its stream termination policy"), { failureCode: local.code });
  }
}
module.exports = { DEFAULT_LIMITS, DEFAULT_TIMEOUTS, parseNativeSse, createNativeTracker, validateRecord, encodeRecord, NativeSseWriter, relayNativeSse, boundedLocalError, redactNativeErrorRecord };
