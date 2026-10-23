"use strict";
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { validateConfig } = require("./config");
const { toResponsesRequest, extractResponse, ignoredClientFields } = require("./adapter");
const { safeRecord } = require("./logger");
const { normalizeChatDefaults } = require("./chat-contract");
const { validationDiagnostics } = require("./diagnostics");
const { ByteStore, transportError, waitWithTimeout, readBoundedBody, SseWriter, streamResponse } = require("./sse");
const { NativeSseWriter, relayNativeSse } = require("./native-sse");
const { validateNativeRequest, createNativeResponsePolicy, validateNativeResponse, redactNativeResponse } = require("./native-request");
const SERVICE = "azure-responses-bridge", PROTOCOL = "chat-to-responses-v1", BUILD = "adapter-v2.11-native-create";
function validateListenerTls(config) {
  if (!config.tlsCert && !config.tlsKey) return undefined;
  try {
    if (!config.tlsCert || !config.tlsKey) throw new Error("Incomplete TLS configuration");
    // Certificate/private-key reads happen at explicit startup, never on import.
    const readPem = file => {
      let fd;
      try {
        // A typo selecting a FIFO/device must not block config checks or startup.
        fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK || 0));
        const info = fs.fstatSync(fd);
        if (!info.isFile() || info.size < 1 || info.size > 1024 * 1024) throw new Error("Invalid PEM file");
        return fs.readFileSync(fd);
      } finally { if (fd !== undefined) fs.closeSync(fd); }
    };
    const options = { cert: readPem(config.tlsCert), key: readPem(config.tlsKey), minVersion: "TLSv1.2" };
    tls.createSecureContext(options);
    return options;
  } catch {
    throw Object.assign(new Error("Invalid listener TLS configuration"), { code: "INVALID_CONFIG", param: "tls" });
  }
}
function requestError(code, message, status) { return Object.assign(transportError(code, message, status), { type: "invalid_request_error", param: "body" }); }
const SAFE_HEADERS = ["retry-after", "retry-after-ms", "x-ms-retry-after-ms", "x-request-id", "request-id", "apim-request-id"];
// Retry advice only makes sense on a failed response; success would imply a retry.
const RETRY_HEADERS = new Set(["retry-after", "retry-after-ms", "x-ms-retry-after-ms"]);
function sendJson(res, status, value) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" }); res.end(body);
}
function hasAuth(req, token) {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || "");
  if (!match) return false;
  const a = Buffer.from(match[1]), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readRequest(req, { signal, maxBytes, uploadMs }) {
  const length = req.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) return Promise.reject(requestError("request_too_large", "Request body exceeds configured byte limit", 413));
  return new Promise((resolve, reject) => {
    let timer, settled = false; const store = new ByteStore(maxBytes);
    const cleanup = () => { clearTimeout(timer); req.off("data", data); req.off("end", end); req.off("aborted", aborted); req.off("error", failed); signal.removeEventListener("abort", cancelled); };
    const finish = (fn, value) => { if (settled) return; settled = true; cleanup(); fn(value); };
    const data = chunk => { if (store.size + chunk.length > maxBytes) finish(reject, requestError("request_too_large", "Request body exceeds configured byte limit", 413)); else store.append(chunk); };
    const end = () => {
      let value; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(store.take())); }
      catch { finish(reject, requestError("invalid_json", "Request body must be valid UTF-8 JSON", 400)); return; }
      finish(resolve, value);
    };
    const aborted = () => finish(reject, transportError("client_cancelled", "Client disconnected", 499));
    const failed = () => finish(reject, transportError("client_cancelled", "Client upload failed", 499));
    const cancelled = () => finish(reject, signal.reason);
    if (signal.aborted) { finish(reject, signal.reason); return; }
    req.on("data", data); req.once("end", end); req.once("aborted", aborted); req.once("error", failed); signal.addEventListener("abort", cancelled, { once: true });
    timer = setTimeout(() => finish(reject, transportError("upload_timeout", "Request upload timed out", 408)), uploadMs);
  });
}
function safeHeaders(upstream, res, secrets, status) {
  for (const name of SAFE_HEADERS) {
    if (status < 400 && RETRY_HEADERS.has(name)) continue;
    const value = upstream.headers.get(name);
    if (!value || value.length > 128 || /[\r\n\0]/.test(value) || secrets.some(secret => value.includes(secret))) continue;
    if (name === "retry-after") { if (!/^\d{1,10}$/.test(value) && !Number.isFinite(Date.parse(value))) continue; }
    else if (name.endsWith("-ms")) { if (!/^\d{1,10}$/.test(value)) continue; }
    else if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(value)) continue;
    res.setHeader(name, value);
  }
}
function createBridgeServer(rawConfig, { fetchImpl = globalThis.fetch, logger = () => {}, allowHttpLocalhostForTests = false } = {}) {
  if (allowHttpLocalhostForTests && fetchImpl === globalThis.fetch) throw new Error("HTTP test seam requires an injected fetch implementation");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  const config = validateConfig(rawConfig, { allowHttpLocalhostForTests });
  let closing = false, shutdownPromise;
  const active = new Set(), sockets = new Set();
  // Bounded admission: parallel agent workflows legitimately exceed a small
  // concurrency cap, so a request waits briefly for a slot instead of failing
  // with a non-SSE 429 that clients report as an empty stream.
  const waiters = [];
  let inFlight = 0, queuedPeak = 0;
  const capacityError = (message) => Object.assign(transportError("capacity_exceeded", message, 429), { type: "rate_limit_error" });
  const takeSlot = () => { if (inFlight < config.limits.maxConcurrent) { inFlight++; return true; } return false; };
  const dropWaiter = waiter => { const index = waiters.indexOf(waiter); if (index >= 0) waiters.splice(index, 1); };
  const acquireSlot = signal => {
    if (takeSlot()) return Promise.resolve();
    if (config.limits.maxQueue === 0 || waiters.length >= config.limits.maxQueue) return Promise.reject(capacityError("Bridge concurrency limit reached"));
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      const settle = (fn, value) => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); dropWaiter(waiter); fn(value); };
      const aborted = () => settle(reject, signal?.reason ?? capacityError("Request cancelled while waiting"));
      const timer = setTimeout(() => settle(reject, capacityError("Timed out waiting for a bridge slot")), config.timeouts.capacityWaitMs);
      if (signal?.aborted) { aborted(); return; }
      signal?.addEventListener("abort", aborted, { once: true });
      waiters.push(waiter);
      queuedPeak = Math.max(queuedPeak, waiters.length);
    });
  };
  const releaseSlot = () => {
    const next = waiters.shift();
    if (next) { next.resolve(); return; } // Slot transfers; inFlight unchanged.
    if (inFlight > 0) inFlight--;
  };
  const identity = { service: SERVICE, protocol: PROTOCOL, build: BUILD, configId: config.configId };
  // Only meaningful credentials are scrubbed; very short values would otherwise
  // mangle ordinary words in messages and correlation fields.
  const REDACT_MIN_LENGTH = 8;
  const redactable = value => typeof value === "string" && value.length >= REDACT_MIN_LENGTH;
  const secretsToHide = [config.azureApiKey, config.proxyToken].filter(redactable);
  const safeToken = (value, fallback = null) => typeof value === "string" && /^[a-zA-Z0-9._:\[\]-]{1,128}$/.test(value) && !secretsToHide.some(s => value.includes(s)) ? value : fallback;
  const envelope = error => {
    let message = typeof error?.message === "string" ? error.message : "Upstream request failed";
    for (const secret of [config.azureApiKey, config.proxyToken, config.azureBase].filter(redactable)) message = message.split(secret).join("[redacted]");
    message = message.replace(/[\r\n\0]/g, " ").slice(0, 512);
    return { error: { message, type: safeToken(error?.type, "upstream_error"), code: safeToken(String(error?.code ?? "upstream_error")), ...(safeToken(error?.param) ? { param: error.param } : {}) } };
  };
  const log = fields => {
    const record = safeRecord("request", fields); delete record.time; delete record.event;
    for (const [key, value] of Object.entries(record)) if (typeof value === "string" && secretsToHide.some(s => value.includes(s))) delete record[key];
    try { logger("request", record); } catch {}
  };
  const validateTools = (response, payload) => {
    if (!Array.isArray(response?.output)) return; // Shared mapper validates shape.
    const allowed = new Set((payload.tools || []).map(tool => tool.name));
    for (const item of response.output) if (item?.type === "function_call" && (payload.tool_choice === "none" || !allowed.has(item.name) || payload.tool_choice?.type === "function" && payload.tool_choice.name !== item.name)) throw transportError("undeclared_upstream_tool", "Upstream requested a function not allowed by this request");
  };
  const tlsOptions = validateListenerTls(config);
  const server = (tlsOptions ? https : http).createServer(tlsOptions ?? {}, async (req, res) => {
    const started = Date.now(), requestId = crypto.randomUUID();
    let path = "unmatched", outcome = "local_error", firstTokenMs, payload, alias, upstreamRequestId, usage, upstream, normalizedFields, finishReason;
    let controller, totalTimer, writer, nativeWriter, nativeMode = false, entry, body, stage = "routing", validation = {}, bytesOut, queuedFor, nativeCode, streamEventName;
    res.setHeader("x-request-id", requestId);
    try {
      const requestUrl = new URL(req.url, "http://127.0.0.1");
      path = requestUrl.pathname;
      if (req.method === "GET" && path === "/healthz") { outcome = "health"; sendJson(res, 200, { ...identity, status: "ok" }); return; }
      if (req.method === "GET" && path === "/readyz") { outcome = "readiness"; sendJson(res, closing ? 503 : 200, { ...identity, status: closing ? "not_ready" : "ready" }); return; }
      if (req.method === "GET" && path === "/v1/models") { outcome = "models"; sendJson(res, 200, { object: "list", data: Object.keys(config.models).map(id => ({ id, object: "model", created: 0, owned_by: "local" })) }); return; }
      const nativeRoute = req.method === "POST" && path === "/v1/responses";
      if ((nativeRoute && !config.nativeResponses) || req.method !== "POST" || (path !== "/v1/chat/completions" && !nativeRoute)) { sendJson(res, 404, envelope({ message: "Not found", type: "invalid_request_error", code: "not_found" })); return; }
      nativeMode = nativeRoute;
      if (closing) throw transportError("shutting_down", "Bridge is shutting down", 503);
      stage = "authentication";
      if (!hasAuth(req, config.proxyToken)) throw Object.assign(transportError("invalid_api_key", "Invalid or missing local proxy credential", 401), { type: "authentication_error" });
      if (nativeMode && requestUrl.search) throw Object.assign(requestError("unsupported_parameter", "Native query controls are not implemented", 400), { param: "query" });
      stage = "capacity";
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) throw Object.assign(transportError("unsupported_media_type", "Request Content-Type must be application/json", 415), { type: "invalid_request_error" });
      controller = new AbortController(); entry = { controller, res }; active.add(entry);
      const disconnected = () => { if (!res.writableEnded) controller.abort(transportError("client_cancelled", "Client disconnected", 499)); };
      entry.cleanup = () => { res.off("close", disconnected); req.off("aborted", disconnected); };
      res.once("close", disconnected); req.once("aborted", disconnected);
      totalTimer = setTimeout(() => controller.abort(transportError("total_timeout", "Request lifetime exceeded", 504)), config.timeouts.totalMs);
      await acquireSlot(controller.signal);
      entry.holdsSlot = true;
      queuedFor = Date.now() - started;
      stage = "upload";
      body = await readRequest(req, { signal: controller.signal, maxBytes: config.limits.requestBytes, uploadMs: config.timeouts.uploadMs });
      stage = "request_conversion";
      if (!nativeMode && body && typeof body === "object" && !Array.isArray(body)) alias = Object.hasOwn(body, "model") ? (typeof body.model === "string" && Object.hasOwn(config.models, body.model) ? body.model : undefined) : config.defaultModel;
      if (nativeMode) {
        const validated = validateNativeRequest(body, config); alias = validated.alias; payload = validated.payload;
        entry.nativePolicy = createNativeResponsePolicy(validated);
      } else payload = toResponsesRequest(body, config);
      if (!nativeMode) normalizedFields = [...new Set([...normalizeChatDefaults(body).normalizedFields,
        ...["temperature", "top_p", "prompt_cache_key", "parallel_tool_calls"].filter(name => Object.hasOwn(body, name) && !Object.hasOwn(payload, name)),
        ...ignoredClientFields(body, config)])];
      stage = "upstream_headers";
      const encodedRequest = JSON.stringify(payload);
      if (nativeMode && Buffer.byteLength(encodedRequest) > config.limits.requestBytes) throw requestError("request_too_large", "Encoded native request exceeds configured byte limit", 413);
      const fetchPromise = Promise.resolve(fetchImpl(new URL("/openai/v1/responses", config.azureBase), { method: "POST", redirect: "error",
        headers: { "Content-Type": "application/json", Accept: payload.stream ? "text/event-stream" : "application/json", "api-key": config.azureApiKey }, body: encodedRequest, signal: controller.signal }));
      // An injected implementation ignoring abort can resolve after our deadline;
      // dispose its late body without waiting for an uncooperative cancel promise.
      fetchPromise.then(value => { if (controller.signal.aborted) { try { Promise.resolve(value?.body?.cancel()).catch(() => {}); } catch {} } }, () => {});
      upstream = await waitWithTimeout(fetchPromise, { signal: controller.signal, timeoutMs: config.timeouts.upstreamIdleMs });
      if (!upstream || !Number.isInteger(upstream.status) || !upstream.headers?.get || upstream.redirected || upstream.status >= 300 && upstream.status < 400) throw transportError("invalid_upstream_response", "Upstream redirect or response shape is invalid");
      safeHeaders(upstream, res, [config.azureApiKey, config.proxyToken], upstream.status); upstreamRequestId = safeToken(upstream.headers.get("apim-request-id") || upstream.headers.get("x-request-id") || upstream.headers.get("request-id"));
      const mime = (upstream.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
      const read = maxBytes => readBoundedBody(upstream.body, { signal: controller.signal, idleMs: config.timeouts.upstreamIdleMs, maxBytes: Math.min(maxBytes, config.limits.responseBytes) });
      if (upstream.status < 200 || upstream.status >= 300) {
        const raw = await read(config.limits.errorBytes); let error = { message: `Upstream returned HTTP ${upstream.status}`, code: String(upstream.status), type: "upstream_error" };
        if (mime === "application/json") { try { const source = JSON.parse(raw)?.error; if (source && typeof source === "object") error = { ...error, message: typeof source.message === "string" ? source.message : error.message, type: source.type, code: source.code ?? error.code, param: source.param }; } catch {} }
        if (nativeMode) nativeCode = safeToken(String(error.code ?? upstream.status), String(upstream.status));
        outcome = "upstream_http_error"; sendJson(res, upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502, envelope(error)); return;
      }
      if (upstream.status !== 200) throw transportError("invalid_upstream_status", "Upstream success status must be 200");
      if (payload.stream) {
        stage = "streaming";
        if (mime !== "text/event-stream") throw transportError("invalid_upstream_content_type", "Upstream streaming Content-Type must be text/event-stream");
        if (nativeMode) {
          nativeWriter = new NativeSseWriter(res, { signal: controller.signal, stallMs: config.timeouts.downstreamStallMs, maxBytes: config.limits.responseBytes });
          const result = await relayNativeSse(upstream, res, { writer: nativeWriter, signal: controller.signal,
            limits: { responseBytes: config.limits.responseBytes, sseLineBytes: config.limits.sseLineBytes, sseEventBytes: config.limits.sseEventBytes, sseBufferBytes: config.limits.sseBufferBytes, downstreamBytes: config.limits.responseBytes },
            timeouts: { upstreamIdleMs: config.timeouts.upstreamIdleMs, downstreamStallMs: config.timeouts.downstreamStallMs, policyMs: config.timeouts.upstreamIdleMs },
            beforeEmit: (info, eventPayload) => {
              const allowed = entry.nativePolicy(info, eventPayload);
              if ((info.category.startsWith("lifecycle") || info.name === "response.cancelled") && eventPayload.response?.usage !== undefined) usage = eventPayload.response.usage;
              return allowed;
            },
            secrets: [config.azureApiKey, config.proxyToken, config.azureBase],
            onDiagnostic: info => {
              if (info.code) nativeCode = info.code;
              if (["response.output_text.delta", "response.refusal.delta", "response.reasoning_summary_text.delta", "response.function_call_arguments.delta"].includes(info.eventName)) firstTokenMs ??= Date.now() - started;
            },
          });
          outcome = result.outcome === "error" ? "upstream_stream_error" : result.outcome.slice(9); bytesOut = result.bytesOut; return;
        }
        writer = new SseWriter(res, { signal: controller.signal, stallMs: config.timeouts.downstreamStallMs, maxBytes: config.limits.responseBytes }); writer.start();
        const result = await streamResponse(upstream, writer, { alias, limits: config.limits, timeouts: config.timeouts, signal: controller.signal, secrets: secretsToHide,
          includeUsage: body.stream_options?.include_usage === true, validateTools: value => validateTools(value, payload), onUsage: value => { usage = value; }, onFirstToken: () => { firstTokenMs ??= Date.now() - started; } });
        outcome = result.outcome; finishReason = result.finishReason; usage = result.rawUsage;
        // Bytes actually written downstream: distinguishes "we sent nothing"
        // from a client-side empty-stream report.
        bytesOut = writer.bytes; return;
      }
      if (mime !== "application/json") throw transportError("invalid_upstream_content_type", "Upstream JSON Content-Type must be application/json");
      stage = "upstream_body";
      const raw = await read(config.limits.jsonBytes); let response;
      try { response = JSON.parse(raw); } catch { throw transportError("invalid_upstream_json", "Upstream response must be valid JSON"); }
      stage = "response_conversion";
      if (nativeMode) {
        usage = response?.usage;
        validateNativeResponse(response, entry.nativePolicy);
        const nativeResponse = redactNativeResponse(response, [config.azureApiKey, config.proxyToken, config.azureBase]);
        const bytes = Buffer.byteLength(JSON.stringify(nativeResponse));
        if (bytes > config.limits.responseBytes) throw transportError("downstream_response_too_large", "Encoded native response exceeds configured byte limit");
        bytesOut = bytes; outcome = nativeResponse.status; firstTokenMs = Date.now() - started;
        sendJson(res, 200, nativeResponse); return;
      }
      usage = response?.usage; validateTools(response, payload); const mapped = extractResponse(response, alias);
      if (Buffer.byteLength(JSON.stringify(mapped)) > config.limits.responseBytes) throw transportError("downstream_response_too_large", "Encoded response exceeds configured byte limit");
      finishReason = mapped.choices[0].finish_reason;
      outcome = finishReason === "length" ? "incomplete" : finishReason === "content_filter" ? "content_filter" : mapped.bridge_warnings?.includes("suppressed_invalid_or_incomplete_tool_calls") ? "partial" : "completed";
      firstTokenMs = Date.now() - started; sendJson(res, 200, mapped);
    } catch (error) {
      validation = validationDiagnostics(error, stage, body, [config.azureApiKey, config.proxyToken]);
      // Only the Chat stream attaches this bounded event name; payloads and text never are logged.
      if (writer && typeof error?.eventName === "string") streamEventName = error.eventName;
      const outcomeCode = nativeMode ? error?.failureCode ?? error?.code : error?.code;
      if (nativeMode) nativeCode = safeToken(outcomeCode, "upstream_error");
      outcome = outcomeCode === "client_cancelled" ? "client_cancelled" : outcomeCode === "shutting_down" ? "shutdown" : /timeout$/.test(outcomeCode || "") ? "timeout" : nativeWriter ? "native_stream_error" : writer ? "stream_error" : (error?.status || 502) < 500 ? "validation_error" : "upstream_error";
      if (nativeWriter && res.headersSent) {
        if (!nativeWriter.closed && !res.destroyed && !res.writableEnded) await nativeWriter.bridgeError(error);
      } else if (writer) { if (["client_cancelled", "shutting_down"].includes(error?.code)) res.destroy(); else await writer.fail(envelope(error)); }
      else if (!res.headersSent && !res.destroyed) { res.setHeader("Connection", "close"); if (error?.status === 429) res.setHeader("retry-after", "1"); sendJson(res, error?.status >= 400 && error.status <= 599 ? error.status : 502, envelope(error)); }
      else if (!res.writableEnded) res.destroy();
    } finally {
      clearTimeout(totalTimer); if (controller && !controller.signal.aborted) controller.abort(transportError("request_finished", "Request finished"));
      if (upstream?.body && !upstream.body.locked) { try { Promise.resolve(upstream.body.cancel()).catch(() => {}); } catch {} }
      entry?.cleanup(); if (entry) active.delete(entry);
      // Release the admission slot last so a queued request can take over.
      if (entry?.holdsSlot) { entry.holdsSlot = false; releaseSlot(); }
      if (nativeWriter) bytesOut ??= nativeWriter.bytes;
      const route = config.models[alias];
      log({ requestId, upstreamRequestId, method: req.method, path, status: res.statusCode, outcome, ...(nativeMode && nativeCode ? { code: nativeCode } : {}), ...(streamEventName ? { eventName: streamEventName } : {}), model: alias, deployment: route?.deployment, variant: route?.variant, version: route?.version,
        effort: payload?.reasoning?.effort, mode: payload?.reasoning?.mode, context: payload?.reasoning?.context, latencyMs: Date.now() - started, firstTokenMs, usage, normalizedFields, finishReason, stage, bytesOut, queuedFor, ...validation });
    }
  });
  // A request may wait out the admission budget before its body is read, so the
  // server deadline must cover queue wait plus upload rather than upload alone.
  server.requestTimeout = Math.min(config.timeouts.capacityWaitMs + config.timeouts.uploadMs, 86400000); server.headersTimeout = Math.min(config.timeouts.uploadMs, 60000); server.keepAliveTimeout = 5000;
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.shutdown = () => {
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = new Promise(resolve => {
      const timer = setTimeout(() => {
        for (const entry of active) { entry.controller.abort(transportError("shutting_down", "Bridge is shutting down", 503)); entry.res.destroy(); }
        for (const socket of sockets) socket.destroy(); resolve();
      }, config.timeouts.shutdownMs);
      server.close(() => { clearTimeout(timer); resolve(); }); server.closeIdleConnections?.();
    });
    return shutdownPromise;
  };
  return server;
}
module.exports = { SERVICE, PROTOCOL, BUILD, SAFE_HEADERS, createBridgeServer, validateListenerTls };
