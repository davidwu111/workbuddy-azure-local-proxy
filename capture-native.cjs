#!/usr/bin/env node
"use strict";

// Guarded capture harness for the bridge's native /v1/responses route.
//
// It talks only to the configured local bridge, never to Azure directly; it
// never reads .env or any other configuration file.
// It performs NO network work until every guard has passed.
// It does not authorize spending by itself: BRIDGE_LIVE_APPROVAL is an
// operator-supplied non-secret reference, not a budget approval.
//
// Dependency-free, single POST, no retries, bounded and sanitized evidence.

const fs = require("node:fs");
const path = require("node:path");

const SHAPES = ["flat-error", "reasoning-nullable-summary", "annotations-null", "image-streaming", "output-boundary", "multi-call"];
const DEFAULT_OUT = "test-fixtures/azure-responses/captured";
const DEFAULT_ALIAS = "gpt-6-luna";
const DEFAULT_IMAGE_MODEL = "gpt-image-1";
const DEFAULT_MAX_OUTPUT_TOKENS = 128000;
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 200000;
const MAX_UNPARSED_CHARS = 200;
const ENDPOINT_PATH = "/v1/responses";
const REDACTED = "[redacted]";
const SECRET_KEY = /^(authorization|api-key|x-api-key|cookie|set-cookie)$/i;
const SECRET_SUFFIX = /(_key|_token)$/i;

function boundedLine(message, limit = 900) {
  const flat = String(message).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit - 3)}...` : flat;
}

function parseCli(argv) {
  const options = { dryRun: false, shape: null, out: null };
  const problems = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      options.dryRun = true;
    } else if (argument === "--shape" || argument === "--out") {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) problems.push(`missing value for ${argument}`);
      else { options[argument.slice(2)] = value; index += 1; }
    } else {
      // Never echo an arbitrary argument; it could be a misplaced secret.
      problems.push("unknown or malformed CLI argument");
    }
  }
  return { options, problems };
}

function readInteger(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[0-9]{1,9}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function isLoopbackHost(hostname) {
  if (typeof hostname !== "string") return false;
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1" || /^127\./.test(host);
}

function looksLikeJwt(value) {
  return /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(value);
}

function normalizeBase(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "BRIDGE_LIVE_BASE_URL must be an absolute http(s) URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { error: "BRIDGE_LIVE_BASE_URL must use http or https" };
  if (url.username || url.password) return { error: "BRIDGE_LIVE_BASE_URL must not contain credentials" };
  if (url.search) return { error: "BRIDGE_LIVE_BASE_URL must not contain a query" };
  if (url.hash) return { error: "BRIDGE_LIVE_BASE_URL must not contain a fragment" };
  if (url.pathname !== "/" && url.pathname !== "") return { error: "BRIDGE_LIVE_BASE_URL must not contain a path beyond /" };
  return { endpoint: `${url.protocol}//${url.host}${ENDPOINT_PATH}`, hostname: url.hostname };
}

function collectGuards(env, options, cliProblems) {
  const problems = [...cliProblems];
  const add = (condition, reason) => {
    if (condition) problems.push(reason);
  };
  const shape = options.shape;
  if (!shape) add(true, `missing --shape (allowed: ${SHAPES.join(", ")})`);
  else add(!SHAPES.includes(shape), `unknown --shape (allowed: ${SHAPES.join(", ")})`);

  const approval = typeof env.BRIDGE_LIVE_APPROVAL === "string" ? env.BRIDGE_LIVE_APPROVAL : "";
  if (!approval) add(true, "missing BRIDGE_LIVE_APPROVAL");
  else {
    add(!/^[\x21-\x7e]{1,128}$/.test(approval), "BRIDGE_LIVE_APPROVAL must be 1-128 printable ASCII characters without whitespace");
    add(/^sk-/i.test(approval) || /^Bearer\s/.test(approval), "BRIDGE_LIVE_APPROVAL must be a non-secret reference, not sk- or Bearer");
    add(looksLikeJwt(approval), "BRIDGE_LIVE_APPROVAL must not look like a JWT");
    add(/^[0-9a-fA-F]{32,}$/.test(approval), "BRIDGE_LIVE_APPROVAL must not look like a hex secret");
  }

  let base = null;
  const baseRaw = typeof env.BRIDGE_LIVE_BASE_URL === "string" ? env.BRIDGE_LIVE_BASE_URL.trim() : "";
  if (!baseRaw) add(true, "missing BRIDGE_LIVE_BASE_URL");
  else {
    const normalized = normalizeBase(baseRaw);
    if (normalized.error) add(true, normalized.error);
    else base = normalized;
  }
  add(Boolean(base) && !isLoopbackHost(base.hostname) && env.BRIDGE_LIVE_ALLOW_REMOTE !== "1", "non-loopback BRIDGE_LIVE_BASE_URL requires BRIDGE_LIVE_ALLOW_REMOTE=1");

  const token = typeof env.BRIDGE_LIVE_TOKEN === "string" ? env.BRIDGE_LIVE_TOKEN : "";
  if (!token) add(true, "missing BRIDGE_LIVE_TOKEN");
  else add(!/^[\x21-\x7e]{1,4096}$/.test(token), "BRIDGE_LIVE_TOKEN must be 1-4096 printable ASCII characters without whitespace");

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (env.BRIDGE_LIVE_TIMEOUT_MS !== undefined && env.BRIDGE_LIVE_TIMEOUT_MS !== "") {
    const parsed = readInteger(env.BRIDGE_LIVE_TIMEOUT_MS);
    if (parsed === null || parsed < MIN_TIMEOUT_MS || parsed > MAX_TIMEOUT_MS) {
      add(true, `BRIDGE_LIVE_TIMEOUT_MS must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
    } else timeoutMs = parsed;
  }

  const out = (options.out === null ? DEFAULT_OUT : options.out).trim();
  if (!out) add(true, "--out must not be empty");
  else if (out.length > 1024 || out.includes("\u0000")) add(true, "--out must be at most 1024 characters");

  let alias = DEFAULT_ALIAS;
  if (shape === "flat-error" && env.BRIDGE_LIVE_ALIAS !== undefined && env.BRIDGE_LIVE_ALIAS !== "") {
    alias = String(env.BRIDGE_LIVE_ALIAS).trim();
    add(!/^[\x21-\x7e]{1,128}$/.test(alias), "BRIDGE_LIVE_ALIAS must be 1-128 printable ASCII characters without whitespace");
  }

  let imageModel = DEFAULT_IMAGE_MODEL;
  if (shape === "image-streaming" && env.BRIDGE_LIVE_IMAGE_MODEL !== undefined && env.BRIDGE_LIVE_IMAGE_MODEL !== "") {
    imageModel = String(env.BRIDGE_LIVE_IMAGE_MODEL).trim();
    add(!/^[\x21-\x7e]{1,128}$/.test(imageModel), "BRIDGE_LIVE_IMAGE_MODEL must be 1-128 printable ASCII characters without whitespace");
  }

  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  if (shape === "output-boundary" && env.BRIDGE_LIVE_MAX_OUTPUT_TOKENS !== undefined && env.BRIDGE_LIVE_MAX_OUTPUT_TOKENS !== "") {
    const parsed = readInteger(env.BRIDGE_LIVE_MAX_OUTPUT_TOKENS);
    if (parsed === null || parsed < 1 || parsed > 1000000) add(true, "BRIDGE_LIVE_MAX_OUTPUT_TOKENS must be an integer from 1 to 1000000");
    else maxOutputTokens = parsed;
  }

  const config = { shape, dryRun: options.dryRun, out, endpoint: base ? base.endpoint : null, hostname: base ? base.hostname : null, token, approval, timeoutMs, alias, imageModel, maxOutputTokens };
  if (problems.length) return { ok: false, problems };
  return { ok: true, config };
}

function buildRequest(config) {
  const fn = (name) => ({ type: "function", name, parameters: { type: "object", properties: {} } });
  switch (config.shape) {
    case "flat-error":
      return { model: config.alias, input: "x", max_output_tokens: 2048, tools: [fn("probe")], tool_choice: { type: "function", name: "definitely_not_declared" }, stream: true };
    case "reasoning-nullable-summary":
      return { input: "Answer with one word: ok.", reasoning: { effort: "low" }, max_output_tokens: 2048, stream: true };
    case "annotations-null":
      return { input: "Answer with one word: ok.", include: ["message.output_text.logprobs"], top_logprobs: 1, max_output_tokens: 2048, stream: true };
    case "image-streaming":
      return { input: "Draw a single red square.", stream: true, max_output_tokens: 2048, tools: [{ type: "image_generation", model: config.imageModel }] };
    case "output-boundary":
      return { input: "Answer with one word: ok.", max_output_tokens: config.maxOutputTokens, stream: false };
    case "multi-call":
      return { input: "Call both tools once, then stop.", max_output_tokens: 4096, stream: true, parallel_tool_calls: true, tools: [fn("probe_a"), fn("probe_b")] };
    default:
      throw new Error("unreachable shape");
  }
}

function redactText(value, secrets) {
  let text = value;
  for (const secret of secrets) if (secret) text = text.split(secret).join(REDACTED);
  return text.replace(/sk-[A-Za-z0-9_-]{20,}/g, REDACTED);
}

function sanitize(value, secrets) {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, secrets));
  if (!value || typeof value !== "object") return value;
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) output[key] = REDACTED;
    else if (SECRET_SUFFIX.test(key) && typeof item === "string" && item.length > 16) output[key] = REDACTED;
    else output[key] = sanitize(item, secrets);
  }
  return output;
}

function parseSse(text) {
  const events = [];
  let dataLines = [];
  let done = false;
  const flush = () => {
    if (!dataLines.length) return;
    const payload = dataLines.join("\n");
    dataLines = [];
    if (payload.trim() === "[DONE]") {
      done = true;
      return;
    }
    try {
      events.push(JSON.parse(payload));
    } catch {
      events.push({ unparsed: payload.slice(0, MAX_UNPARSED_CHARS) });
    }
  };
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") {
      flush();
      if (done) break;
    } else if (line.startsWith("data:")) {
      let payload = line.slice(5);
      if (payload.startsWith(" ")) payload = payload.slice(1);
      dataLines.push(payload);
    }
  }
  if (!done) flush();
  return { events, done };
}

function checkLineBounds(text) {
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (Buffer.byteLength(line, "utf8") > MAX_SSE_LINE_BYTES) return `SSE line exceeded ${MAX_SSE_LINE_BYTES} bytes`;
  }
  return null;
}
function terminalResponse(events) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event && typeof event === "object" && !Array.isArray(event) && event.response && typeof event.response === "object") return event.response;
  }
  return null;
}

function noteFor(status, isSse, response) {
  if (status < 200 || status >= 300) return "provider error shape";
  if (!isSse) return "json response body";
  return response ? "terminal event response" : "stream events only";
}

async function readBody(response, isAborted) {
  if (!response.body || typeof response.body.getReader !== "function") return { text: "", error: "empty response body" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let error = null;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        error = "response body exceeded 8 MiB";
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    if (!error) text += decoder.decode();
  } catch {
    error = isAborted() ? "request timed out" : "response body read failed";
  } finally {
    try {
      await reader.cancel();
    } catch {
      // No data is retained from a cancelled read.
    }
    try {
      reader.releaseLock();
    } catch {
      // Ignore lock release failures.
    }
  }
  return { text, error };
}

async function capture(config, bodyText) {
  const controller = new AbortController();
  const aborted = () => controller.signal.aborted;
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    let response;
    try {
      response = await fetch(config.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
        body: bodyText,
        signal: controller.signal,
        redirect: "error",
      });
    } catch {
      return { ok: false, message: aborted() ? `request timed out after ${config.timeoutMs} ms` : "bridge unreachable" };
    }
    const status = response.status;
    const contentType = response.headers.get("content-type");
    const isSse = typeof contentType === "string" && contentType.split(";")[0].trim().toLowerCase() === "text/event-stream";
    const body = await readBody(response, aborted);
    if (body.error) return { ok: false, message: body.error };
    if (isSse) {
      const lineError = checkLineBounds(body.text);
      if (lineError) return { ok: false, message: lineError };
      const parsed = parseSse(body.text);
      return { ok: true, status, contentType, isSse, events: parsed.events, response: terminalResponse(parsed.events) };
    }
    let parsed;
    try {
      parsed = JSON.parse(body.text);
    } catch {
      return { ok: false, message: "response body was not valid JSON" };
    }
    return { ok: true, status, contentType, isSse, events: [], response: parsed };
  } finally {
    clearTimeout(timer);
  }
}

function writeCapture(outDir, evidence) {
  const directory = path.resolve(process.cwd(), outDir);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${evidence.shape}.json`);
  fs.writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return file;
}

async function main() {
  const parsed = parseCli(process.argv.slice(2));
  const guard = collectGuards(process.env, parsed.options, parsed.problems);
  if (!guard.ok) {
    console.error(boundedLine(`capture-native refused: ${guard.problems.join("; ")}`));
    return 2;
  }
  const config = guard.config;
  const requestBody = buildRequest(config);
  const requestText = JSON.stringify(requestBody);

  if (config.dryRun) {
    console.log(JSON.stringify(requestBody, null, 2));
    return 0;
  }
  if (typeof fetch !== "function") {
    console.error("capture-native refused: this Node runtime has no global fetch");
    return 2;
  }

  const outcome = await capture(config, requestText);
  if (!outcome.ok) {
    console.error(boundedLine(`capture-native failed: ${outcome.message}`));
    return 3;
  }

  const secrets = [config.token, config.approval];
  const evidence = {
    shape: config.shape, capturedAt: new Date().toISOString(), approval: config.approval, endpoint: ENDPOINT_PATH,
    status: outcome.status, contentType: outcome.contentType ?? null, request: sanitize(JSON.parse(requestText), secrets),
    events: sanitize(outcome.events, secrets), response: outcome.response === null ? null : sanitize(outcome.response, secrets),
    notes: noteFor(outcome.status, outcome.isSse, outcome.response),
  };

  const serialized = JSON.stringify(evidence, null, 2);
  if (serialized.includes(config.token)) {
    console.error("capture-native refused: redaction failed; token would be written, capture not saved");
    return 4;
  }

  let file;
  try {
    file = writeCapture(config.out, evidence);
  } catch {
    console.error("capture-native failed: cannot write capture file");
    return 1;
  }

  console.log(`captured ${config.shape} -> ${file} (status ${outcome.status}, ${evidence.events.length} events)`);
  const errorStatusTolerated = config.shape === "flat-error" || config.shape === "output-boundary";
  if ((outcome.status < 200 || outcome.status >= 300) && !errorStatusTolerated) {
    console.error(boundedLine(`capture-native: non-2xx status ${outcome.status} for ${config.shape}; capture written for review`));
    return 5;
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("capture-native failed: internal error (no capture written)");
    process.exitCode = 1;
  });
}

module.exports = { SHAPES, parseCli, collectGuards, buildRequest, sanitize, redactText, parseSse, terminalResponse };
