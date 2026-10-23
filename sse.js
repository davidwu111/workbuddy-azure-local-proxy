"use strict";
const { extractResponse } = require("./adapter");
function upstreamSourceError(source, fallback = "Upstream response failed") {
  return Object.assign(transportError(typeof source?.code === "string" ? source.code : "upstream_stream_error", typeof source?.message === "string" ? source.message : fallback),
    { type: typeof source?.type === "string" ? source.type : "upstream_error", param: source?.param });
}
function transportError(code, message, status = 502) {
  return Object.assign(new Error(message), { code, status, type: "upstream_error" });
}
function waitWithTimeout(promise, { signal, timeoutMs, code = "upstream_idle_timeout" } = {}) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", aborted); fn(value); };
    const aborted = () => finish(reject, signal.reason);
    signal?.addEventListener("abort", aborted, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(reject, transportError(code,
      code === "downstream_stall_timeout" ? "Downstream client stalled" : "Upstream activity timed out", 504)), timeoutMs);
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
  });
}
function waitForDrain(res, { signal, timeoutMs } = {}) {
  if (res.destroyed || res.writableEnded) return Promise.reject(transportError("client_cancelled", "Client disconnected", 499));
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let timer;
    const clean = () => { clearTimeout(timer); res.off("drain", drained); res.off("close", closed); res.off("error", failed); signal?.removeEventListener("abort", aborted); };
    const finish = (fn, value) => { clean(); fn(value); };
    const drained = () => finish(resolve);
    const closed = () => finish(reject, transportError("client_cancelled", "Client disconnected", 499));
    const failed = () => finish(reject, transportError("downstream_error", "Downstream connection failed"));
    const aborted = () => finish(reject, signal.reason);
    res.once("drain", drained); res.once("close", closed); res.once("error", failed);
    signal?.addEventListener("abort", aborted, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => finish(reject, transportError("downstream_stall_timeout", "Downstream client stalled", 504)), timeoutMs);
  });
}
class ByteStore {
  constructor(maxBytes) { this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0); this.size = 0; }
  append(bytes) {
    const size = this.size + bytes.byteLength;
    if (size > this.maxBytes) throw transportError("response_too_large", "Buffered bytes exceed configured limit");
    if (size > this.buffer.length) {
      const capacity = Math.min(this.maxBytes, Math.max(size, 64, this.buffer.length * 2));
      const next = Buffer.allocUnsafe(capacity); this.buffer.copy(next, 0, 0, this.size); this.buffer = next;
    }
    this.buffer.set(bytes, this.size); this.size = size;
  }
  take() { const result = this.buffer.subarray(0, this.size); this.size = 0; return result; }
}
function disposeReader(reader) {
  // A malicious injected cancel promise must not hold shutdown open.
  try { Promise.resolve(reader.cancel()).catch(() => {}); } catch {}
  try { reader.releaseLock(); } catch {}
}
async function* readChunks(body, { signal, idleMs, maxBytes }) {
  if (!body || typeof body.getReader !== "function") throw transportError("empty_upstream_body", "Upstream response has no body");
  const reader = body.getReader(); let bytes = 0;
  try {
    while (true) {
      // Idle applies only while awaiting upstream, never during downstream drain.
      if (signal?.aborted) throw signal.reason;
      const { value, done } = await waitWithTimeout(reader.read(), { signal, timeoutMs: idleMs });
      if (done) return;
      if (!(value instanceof Uint8Array)) throw transportError("invalid_upstream_body", "Upstream body must contain bytes");
      bytes += value.byteLength;
      if (bytes > maxBytes) throw transportError("response_too_large", "Upstream response exceeds configured byte limit");
      yield value;
    }
  } finally { disposeReader(reader); }
}
async function readBoundedBody(body, options) {
  const store = new ByteStore(options.maxBytes);
  for await (const chunk of readChunks(body, options)) store.append(chunk);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(store.take()); }
  catch { throw transportError("invalid_upstream_utf8", "Upstream body is not valid UTF-8"); }
}
async function* parseSse(chunks, limits) {
  const lineStore = new ByteStore(limits.sseLineBytes), dataStore = new ByteStore(limits.sseEventBytes);
  let eventBytes = 0, eventName = "", dataLines = 0, pendingCR = false, firstLine = true;
  const check = (added = 0) => {
    if (lineStore.size + added > limits.sseLineBytes) throw transportError("sse_line_too_large", "Upstream SSE line exceeds configured byte limit");
    if (eventBytes + lineStore.size + added > limits.sseEventBytes) throw transportError("sse_event_too_large", "Upstream SSE event exceeds configured byte limit");
    if (eventBytes + lineStore.size + added > limits.sseBufferBytes) throw transportError("sse_buffer_too_large", "Upstream SSE buffer exceeds configured byte limit");
  };
  const append = bytes => { check(bytes.byteLength); lineStore.append(bytes); };
  const line = delimiterBytes => {
    // Include exact raw delimiters, including both bytes of CRLF.
    if (eventBytes + lineStore.size + delimiterBytes > limits.sseEventBytes) throw transportError("sse_event_too_large", "Upstream SSE event exceeds configured byte limit");
    if (eventBytes + lineStore.size + delimiterBytes > limits.sseBufferBytes) throw transportError("sse_buffer_too_large", "Upstream SSE buffer exceeds configured byte limit");
    const rawBytes = lineStore.size + delimiterBytes;
    let text;
    try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(lineStore.take()); } catch { throw transportError("invalid_sse_utf8", "Upstream SSE is not valid UTF-8"); }
    if (firstLine) { firstLine = false; if (text.startsWith("\uFEFF")) text = text.slice(1); }
    if (!text) {
      const bytes = dataStore.take();
      const result = dataLines ? { event: eventName, data: new TextDecoder().decode(bytes) } : null;
      eventBytes = 0; eventName = ""; dataLines = 0; return result;
    }
    eventBytes += rawBytes;
    if (text.startsWith(":")) return null;
    const colon = text.indexOf(":"); const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1); if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") { if (dataLines++) dataStore.append(Buffer.from("\n")); dataStore.append(Buffer.from(value)); }
    return null;
  };
  for await (const chunk of chunks) {
    let start = 0;
    if (pendingCR && chunk.byteLength) { pendingCR = false; const lf = chunk[0] === 10; const result = line(lf ? 2 : 1); if (lf) start = 1; if (result) yield result; }
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
  if (lineStore.size || dataLines || eventName) throw transportError("truncated_sse_event", "Upstream SSE ended inside an event");
}
class SseWriter {
  constructor(res, { signal, stallMs, maxBytes = 64 * 1024 ** 2 }) { this.res = res; this.signal = signal; this.stallMs = stallMs; this.maxBytes = maxBytes; this.bytes = 0; this.terminal = false; }
  frame(value) {
    const text = `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
    const bytes = Buffer.byteLength(text);
    if (this.bytes + bytes > this.maxBytes) throw transportError("downstream_response_too_large", "Encoded response exceeds configured byte limit");
    this.bytes += bytes; return text;
  }
  start() { this.res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" }); this.res.flushHeaders(); }
  async emit(value, signal = this.signal) {
    if (this.res.destroyed || this.res.writableEnded) throw transportError("client_cancelled", "Client disconnected", 499);
    if (signal?.aborted) throw signal.reason;
    if (!this.res.write(this.frame(value))) await waitForDrain(this.res, { signal, timeoutMs: this.stallMs });
  }
  async finish(frames) {
    if (this.terminal) return; this.terminal = true;
    try { for (const frame of frames) await this.emit(frame); await this.emit("[DONE]"); this.res.end(); }
    catch (error) { this.res.destroy(); throw error; }
  }
  async fail(error) {
    if (this.terminal || this.res.destroyed || this.res.writableEnded) return;
    this.terminal = true;
    try {
      // Do not reopen a drain budget after abort/timeout; make one nonblocking
      // opportunity to terminate. On a stalled socket cancellation means destroy.
      if (this.signal?.aborted || this.res.writableNeedDrain || error?.error?.code === "downstream_stall_timeout") {
        if (!this.res.write(this.frame(error))) { this.res.destroy(); return; }
        if (!this.res.write(this.frame("[DONE]"))) { this.res.destroy(); return; }
        this.res.end(); return;
      }
      await this.emit(error); await this.emit("[DONE]"); this.res.end();
    } catch { this.res.destroy(); }
  }
}
const NOOP_EVENTS = new Set(["response.content_part.added", "response.content_part.done", "response.output_text.done", "response.refusal.done", "response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.done", "response.output_text.annotation.added"]);
// Raw reasoning is intentionally not surfaced. Unlike NOOP_EVENTS these payloads
// are validated (a malformed string still fails) and then discarded: their text
// is never emitted as Chat content or reasoning_content, retained, or logged.
const SUPPRESSED_RAW_REASONING_EVENTS = new Set(["response.reasoning_text.delta", "response.reasoning_text.done"]);
const SAFE_EVENT_NAME = /^[A-Za-z0-9_.-]{1,128}$/;
function boundedEventName(name, secrets = []) {
  return typeof name === "string" && SAFE_EVENT_NAME.test(name) && !secrets.some(secret => typeof secret === "string" && secret && name.includes(secret)) ? name : undefined;
}
function withEventName(error, name, secrets) {
  if (error && typeof error === "object" && error.eventName === undefined && Object.isExtensible(error)) {
    const eventName = boundedEventName(name, secrets);
    if (eventName) error.eventName = eventName;
  }
  return error;
}
async function streamResponse(upstream, writer, { alias, limits, timeouts, signal, includeUsage, validateTools, onFirstToken, onUsage, secrets = [] }) {
  let id = "chatcmpl-response", responseId, created = 0, roleSent = false, retained = 0, displayBytes = 0;
  const textStore = new ByteStore(limits.sseBufferBytes * 2), refusalStore = new ByteStore(limits.sseBufferBytes * 2), reasoningStore = new ByteStore(limits.sseBufferBytes * 2);
  const items = new Map();
  const chunk = (delta, finishReason = null, usage, extra = {}) => ({ id, object: "chat.completion.chunk", created, model: alias,
    choices: delta === null ? [] : [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}), ...extra });
  const role = async () => { if (!roleSent) { roleSent = true; await writer.emit(chunk({ role: "assistant" })); } };
  const check = () => { if (retained + displayBytes > limits.sseBufferBytes) throw transportError("sse_buffer_too_large", "Upstream SSE retained output exceeds configured byte limit"); };
  const save = (index, item, done) => {
    if (!Number.isInteger(index) || index < 0 || !item || typeof item !== "object" || Array.isArray(item) || !["message", "reasoning", "function_call", "compaction"].includes(item.type)) throw transportError("invalid_sse_item", "Upstream SSE output item is invalid");
    if (item.type === "function_call" && item.arguments !== undefined && typeof item.arguments !== "string") throw transportError("invalid_sse_tool_arguments", "Upstream SSE function arguments must be a string");
    const bytes = Buffer.byteLength(JSON.stringify(item)) + 256; retained += bytes - (items.get(index)?.bytes || 0);
    const args = item.type === "function_call" ? new ByteStore(limits.sseBufferBytes * 2) : null;
    if (args && item.arguments) args.append(Buffer.from(item.arguments, "utf16le"));
    items.set(index, { item, done, bytes, args }); check();
  };
  const argumentsOf = state => state.args ? state.args.buffer.subarray(0, state.args.size).toString("utf16le") : "";
  const emitText = async (field, delta) => {
    if (typeof delta !== "string") throw transportError("invalid_sse_delta", "Upstream SSE delta must be a string");
    displayBytes += Buffer.byteLength(delta); check();
    (field === "content" ? textStore : field === "refusal" ? refusalStore : reasoningStore).append(Buffer.from(delta, "utf16le"));
    await role(); if (delta) onFirstToken?.();
    await writer.emit(chunk({ [field]: delta }));
  };
  for await (const event of parseSse(readChunks(upstream.body, { signal, idleMs: timeouts.upstreamIdleMs, maxBytes: limits.responseBytes }), limits)) {
    if (event.data === "[DONE]") throw transportError("premature_done", "Upstream SSE ended without a terminal response");
    let payload; try { payload = JSON.parse(event.data); } catch { throw transportError("invalid_sse_json", "Upstream SSE event is not valid JSON"); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw transportError("invalid_sse_payload", "Upstream SSE payload is invalid");
    if (event.event && payload.type && event.event !== payload.type) throw transportError("sse_event_conflict", "Upstream SSE event/type conflict");
    const name = event.event || payload.type;
    if (typeof name !== "string" || !name) throw transportError("missing_sse_type", "Upstream SSE event has no type");
    try {
      if (name === "response.created" || name === "response.in_progress" || name === "response.queued") {
        if (!payload.response || typeof payload.response !== "object") throw transportError("invalid_sse_response", "Upstream SSE response is invalid");
        if (name === "response.created" || name === "response.queued") {
          if (typeof payload.response.id === "string" && payload.response.id) { if (responseId && responseId !== payload.response.id) throw transportError("sse_identity_conflict", "Upstream SSE response identity conflicts"); responseId = payload.response.id; id = `chatcmpl-${responseId}`; }
          if (Number.isInteger(payload.response.created_at) && payload.response.created_at >= 0) created = payload.response.created_at;
        }
        // A queued notification establishes identity only: no Chat role chunk and no terminal outcome.
        if (name === "response.created") await role();
      } else if (SUPPRESSED_RAW_REASONING_EVENTS.has(name)) {
        const field = name.endsWith(".delta") ? "delta" : "text";
        if (typeof payload[field] !== "string") throw transportError("invalid_sse_reasoning_text", "Upstream SSE raw reasoning text must be a string");
        // Intentionally discarded: raw reasoning never becomes Chat content, reasoning_content, or a log field.
      } else if (name === "response.output_text.delta") await emitText("content", payload.delta);
      else if (name === "response.refusal.delta") await emitText("refusal", payload.delta);
      else if (name === "response.reasoning_summary_text.delta") await emitText("reasoning_content", payload.delta);
      else if (name === "response.output_item.added") {
        if (items.has(payload.output_index)) throw transportError("duplicate_sse_item", "Upstream SSE repeats an output item");
        save(payload.output_index, payload.item, false);
      } else if (name === "response.function_call_arguments.delta") {
        const state = items.get(payload.output_index);
        if (!state || state.done || state.item.type !== "function_call" || (payload.item_id !== undefined && payload.item_id !== state.item.id) || typeof payload.delta !== "string" || (state.item.arguments !== undefined && typeof state.item.arguments !== "string")) throw transportError("invalid_sse_tool_delta", "Upstream SSE function arguments have no active call");
        const added = Buffer.byteLength(JSON.stringify(payload.delta)) - 2;
        retained += added; state.bytes += added; check(); state.args.append(Buffer.from(payload.delta, "utf16le"));
      } else if (name === "response.function_call_arguments.done") {
        const state = items.get(payload.output_index);
        if (!state || state.item.type !== "function_call" || (payload.item_id !== undefined && payload.item_id !== state.item.id) || typeof payload.arguments !== "string") throw transportError("invalid_sse_tool_done", "Upstream SSE function arguments are invalid");
        if (!payload.arguments.startsWith(argumentsOf(state))) throw transportError("sse_tool_conflict", "Upstream SSE function arguments conflict");
        save(payload.output_index, { ...state.item, arguments: payload.arguments }, state.done);
      } else if (name === "response.output_item.done") {
        const state = items.get(payload.output_index);
        if (state?.item.type === "function_call" && (state.item.call_id !== payload.item?.call_id || state.item.name !== payload.item?.name || (typeof payload.item?.arguments !== "string" || !payload.item.arguments.startsWith(argumentsOf(state))))) throw transportError("sse_tool_conflict", "Upstream SSE function call conflicts with completed item");
        save(payload.output_index, payload.item, true);
      } else if (["response.completed", "response.incomplete", "response.failed", "response.cancelled"].includes(name)) {
        const response = payload.response;
        if (!response || typeof response !== "object" || response.status !== name.slice(9)) throw transportError("invalid_sse_terminal", "Upstream SSE terminal response status is invalid");
        onUsage?.(response.usage);
        if (responseId && response.id !== undefined && response.id !== responseId) throw transportError("sse_identity_conflict", "Upstream SSE response identity conflicts");
        // Full terminal output is authoritative. A missing array can be reconstructed
        // only from explicitly done items, never from partial tool argument deltas.
        const done = [...items.entries()].sort((a, b) => a[0] - b[0]).filter(([, s]) => s.done).map(([, s]) => s.item);
        const terminal = response.output === undefined && done.length ? { ...response, output: done } : response;
        validateTools?.(terminal);
        const trackedCalls = new Map();
        for (const state of items.values()) if (state.item.type === "function_call") {
          if (trackedCalls.has(state.item.call_id)) throw transportError("duplicate_sse_call", "Upstream SSE repeats a function call identity");
          trackedCalls.set(state.item.call_id, state);
        }
        const terminalCalls = Array.isArray(terminal.output) ? terminal.output.filter(item => item?.type === "function_call") : [];
        if (response.status === "completed" && Array.isArray(terminal.output)) {
          const finalIds = new Set(terminalCalls.map(item => item.call_id));
          for (const callId of trackedCalls.keys()) if (!finalIds.has(callId)) throw transportError("missing_terminal_tool", "Upstream terminal output omitted a generated function call");
        }
        for (const item of terminalCalls) {
          const state = trackedCalls.get(item.call_id);
          if (state && (state.item.name !== item.name || (typeof item.arguments !== "string" || !item.arguments.startsWith(argumentsOf(state))))) throw transportError("sse_tool_conflict", "Upstream SSE function call conflicts with terminal output");
        }
        const mapped = extractResponse(terminal, alias); const message = mapped.choices[0].message;
        const text = textStore.take().toString("utf16le"), refusal = refusalStore.take().toString("utf16le"), reasoning = reasoningStore.take().toString("utf16le");
        if (!roleSent) { id = mapped.id; created = mapped.created; }
        for (const [field, sent, final] of [["content", text, message.content], ["refusal", refusal, message.refusal], ["reasoning_content", reasoning, message.reasoning_content]]) {
          if (typeof final !== "string") { if (sent) throw transportError("sse_text_conflict", "Upstream terminal output omitted streamed material"); continue; }
          if (!final.startsWith(sent)) throw transportError("sse_text_conflict", "Upstream SSE text conflicts with terminal output");
          const suffix = final.slice(sent.length);
          if (suffix) { await role(); onFirstToken?.(); await writer.emit(chunk({ [field]: suffix })); }
        }
        await role();
        if (message.tool_calls?.length) { onFirstToken?.(); await writer.emit(chunk({ tool_calls: message.tool_calls.map((call, index) => ({ index, ...call })) })); }
        const metadata = { ...(message.annotations ? { annotations: message.annotations } : {}) };
        const extra = { ...(mapped.bridge_warnings ? { bridge_warnings: mapped.bridge_warnings } : {}), ...(Object.hasOwn(mapped, "azure_content_filters") ? { azure_content_filters: mapped.azure_content_filters } : {}) };
        const frames = [chunk(metadata, mapped.choices[0].finish_reason, undefined, extra)];
        if (includeUsage && mapped.usage) frames.push(chunk(null, null, mapped.usage));
        await writer.finish(frames);
        const finishReason = mapped.choices[0].finish_reason;
        const outcome = finishReason === "length" ? "incomplete" : finishReason === "content_filter" ? "content_filter" : mapped.bridge_warnings ? "partial" : "completed";
        return { outcome, finishReason, usage: mapped.usage, rawUsage: response.usage };
      } else if (name === "error") throw upstreamSourceError(payload.error || payload);
      else if (!NOOP_EVENTS.has(name)) throw transportError("unsupported_sse_event", "Upstream SSE event is unsupported");
    } catch (error) {
      // Bound the diagnostic name only; never attach payload, text, or provider data.
      throw withEventName(error, name, secrets);
    }
  }
  throw transportError("missing_sse_terminal", "Upstream SSE ended before a terminal response event");
}
module.exports = { ByteStore, transportError, waitWithTimeout, waitForDrain, disposeReader, readChunks, readBoundedBody, parseSse, SseWriter, streamResponse };
