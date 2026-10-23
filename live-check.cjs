#!/usr/bin/env node
"use strict";

// Guarded live verification harness for the bridge's own local Chat endpoint.
//
// This script is deliberately dependency-free and performs NO network work
// until every approval guard has passed. It talks only to the configured local
// bridge (never to Azure directly), never retries, and records only bounded,
// sanitized evidence. It does not read .env or any other configuration file.
//
// It is intentionally NOT run by the Step 6 offline checks.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_PROMPT = "Reply with the single word: ok.";
const DEFAULT_OUT = "./live-evidence.json";
const MAX_APPROVAL_LENGTH = 128;
const MAX_PROMPT_LENGTH = 200;
const MAX_ALIAS_LENGTH = 128;
const MAX_TOKEN_LENGTH = 4096;
const MAX_OUT_LENGTH = 1024;
const DEFAULT_TIMEOUT_MS = 30000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 120000;
const MAX_STREAM_BYTES = 8 * 1024 * 1024;
const MAX_SSE_LINE_BYTES = 1024 * 1024;
const ENDPOINT_SUFFIX = "/v1/chat/completions";

const USAGE_COUNTERS = new Set([
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
  "input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "cached_tokens",
  "audio_tokens",
  "accepted_prediction_tokens",
  "rejected_prediction_tokens",
]);
const USAGE_CONTAINERS = new Set([
  "prompt_tokens_details",
  "completion_tokens_details",
  "input_tokens_details",
  "output_tokens_details",
]);
const FINISH_REASON = /^[A-Za-z0-9_.:-]{1,64}$/;

function sanitizeTestName(value, maxLength = 64) {
  if (typeof value !== "string") return "unnamed";
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, maxLength);
  return cleaned || "unnamed";
}

function parseCli(argv) {
  const options = { confirm: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--confirm") {
      options.confirm = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--base" || argument === "--token" || argument === "--model" || argument === "--out") {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) {
        return { ok: false, reason: `missing value for ${argument}` };
      }
      options[argument.slice(2)] = value;
      index += 1;
    } else {
      // Never echo an arbitrary argument; it could be a misplaced token.
      return { ok: false, reason: "unknown or malformed CLI argument" };
    }
  }
  return { ok: true, options };
}

function readInteger(raw) {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[0-9]{1,6}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

function isLoopbackHost(hostname) {
  if (typeof hostname !== "string") return false;
  const host = hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "0:0:0:0:0:0:0:1" ||
    /^127\./.test(host)
  );
}

function endpointHostPort(url) {
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.hostname}:${port}`;
}

function normalizeChatEndpoint(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { error: "BRIDGE_LIVE_BASE_URL must be an absolute http(s) URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "BRIDGE_LIVE_BASE_URL must use http or https" };
  }
  if (url.username || url.password) {
    return { error: "BRIDGE_LIVE_BASE_URL must not contain credentials" };
  }
  if (url.search || url.hash) {
    return { error: "BRIDGE_LIVE_BASE_URL must not contain a query or fragment" };
  }
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith(ENDPOINT_SUFFIX)) {
    // Already the exact Chat endpoint.
  } else if (pathname.endsWith("/v1")) {
    pathname += "/chat/completions";
  } else {
    pathname += ENDPOINT_SUFFIX;
  }
  url.pathname = pathname || ENDPOINT_SUFFIX;
  return { url };
}

function validateApproval(env = process.env, argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (!parsed.ok) return { ok: false, message: parsed.reason };
  if (parsed.options.help) return { ok: false, message: "--help does not authorize a live probe" };

  const reasons = [];
  const problems = (condition, reason) => {
    if (condition) reasons.push(reason);
  };

  problems(!parsed.options.confirm, "missing --confirm");

  const approvalRaw = env.BRIDGE_LIVE_APPROVAL;
  const approval = typeof approvalRaw === "string" ? approvalRaw.trim() : "";
  if (!approval) {
    problems(true, "missing BRIDGE_LIVE_APPROVAL");
  } else if (approval.length > MAX_APPROVAL_LENGTH) {
    problems(true, `BRIDGE_LIVE_APPROVAL must be at most ${MAX_APPROVAL_LENGTH} characters`);
  } else if (!/^[\x20-\x7e]+$/.test(approval)) {
    problems(true, "BRIDGE_LIVE_APPROVAL must be printable ASCII");
  } else if (/^Bearer\s+/i.test(approval)) {
    problems(true, "BRIDGE_LIVE_APPROVAL must be a non-secret approval reference, not a bearer token");
  }

  const maxCalls = readInteger(env.BRIDGE_LIVE_MAX_CALLS);
  if (maxCalls === null || maxCalls < 1 || maxCalls > 3) {
    problems(true, "BRIDGE_LIVE_MAX_CALLS must be an integer from 1 to 3");
  }

  const maxOutputTokens = readInteger(env.BRIDGE_LIVE_MAX_OUTPUT_TOKENS);
  if (maxOutputTokens === null || maxOutputTokens < 1 || maxOutputTokens > 512) {
    problems(true, "BRIDGE_LIVE_MAX_OUTPUT_TOKENS must be an integer from 1 to 512");
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (env.BRIDGE_LIVE_TIMEOUT_MS !== undefined && env.BRIDGE_LIVE_TIMEOUT_MS !== "") {
    const parsedTimeout = readInteger(env.BRIDGE_LIVE_TIMEOUT_MS);
    if (parsedTimeout === null || parsedTimeout < MIN_TIMEOUT_MS || parsedTimeout > MAX_TIMEOUT_MS) {
      problems(true, `BRIDGE_LIVE_TIMEOUT_MS must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}`);
    } else {
      timeoutMs = parsedTimeout;
    }
  }

  const baseRaw = parsed.options.base ?? env.BRIDGE_LIVE_BASE_URL;
  let endpoint = null;
  if (typeof baseRaw !== "string" || !baseRaw.trim()) {
    problems(true, "missing BRIDGE_LIVE_BASE_URL or --base");
  } else {
    const normalized = normalizeChatEndpoint(baseRaw.trim());
    if (normalized.error) problems(true, normalized.error);
    else endpoint = normalized.url;
  }

  const allowRemote = env.BRIDGE_LIVE_ALLOW_REMOTE === "1";
  if (endpoint && !isLoopbackHost(endpoint.hostname) && !allowRemote) {
    problems(true, "non-loopback base URL requires BRIDGE_LIVE_ALLOW_REMOTE=1");
  }

  const tokenRaw = parsed.options.token ?? env.BRIDGE_LIVE_TOKEN;
  const token = typeof tokenRaw === "string" ? tokenRaw : "";
  if (!token) {
    problems(true, "missing BRIDGE_LIVE_TOKEN or --token");
  } else if (token.length > MAX_TOKEN_LENGTH) {
    problems(true, `BRIDGE_LIVE_TOKEN must be at most ${MAX_TOKEN_LENGTH} characters`);
  } else if (!/^[\x21-\x7e]+$/.test(token)) {
    problems(true, "BRIDGE_LIVE_TOKEN must be printable ASCII without whitespace");
  }

  if (approval && token && approval === token) {
    problems(true, "BRIDGE_LIVE_APPROVAL must not be the token");
  }

  const modelRaw = parsed.options.model ?? env.BRIDGE_LIVE_MODEL;
  const model = typeof modelRaw === "string" ? modelRaw.trim() : "";
  if (!model) {
    problems(true, "missing BRIDGE_LIVE_MODEL or --model");
  } else if (model.length > MAX_ALIAS_LENGTH || !/^[\x21-\x7e]+$/.test(model)) {
    problems(true, `BRIDGE_LIVE_MODEL must be 1-${MAX_ALIAS_LENGTH} printable ASCII characters without whitespace`);
  }

  const promptRaw = env.BRIDGE_LIVE_PROMPT;
  const prompt = typeof promptRaw === "string" && promptRaw.length ? promptRaw : DEFAULT_PROMPT;
  const promptLength = Array.from(prompt).length;
  if (promptLength < 1 || promptLength > MAX_PROMPT_LENGTH) {
    problems(true, `BRIDGE_LIVE_PROMPT must be 1-${MAX_PROMPT_LENGTH} characters`);
  } else if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(prompt)) {
    problems(true, "BRIDGE_LIVE_PROMPT must not contain control characters");
  }

  const outRaw = parsed.options.out ?? env.BRIDGE_LIVE_OUT ?? DEFAULT_OUT;
  const outPath = typeof outRaw === "string" ? outRaw.trim() : "";
  if (!outPath) {
    problems(true, "evidence output path must not be empty");
  } else if (outPath.length > MAX_OUT_LENGTH || outPath.includes("\u0000")) {
    problems(true, `evidence output path must be at most ${MAX_OUT_LENGTH} characters`);
  }

  if (reasons.length) return { ok: false, message: reasons.join("; ") };

  return {
    ok: true,
    config: {
      approval,
      maxCalls,
      maxOutputTokens,
      prompt,
      endpoint,
      endpointHostPort: endpointHostPort(endpoint),
      token,
      model,
      allowRemote,
      timeoutMs,
      outPath,
    },
  };
}

function sanitizeFinishReason(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && FINISH_REASON.test(value)) return value;
  return "other";
}

function sanitizeUsage(value) {
  const result = {};
  const walk = (node, prefix, depth) => {
    if (!node || typeof node !== "object" || Array.isArray(node) || depth > 3) return;
    for (const key of Object.keys(node).sort()) {
      if (USAGE_CONTAINERS.has(key) && node[key] && typeof node[key] === "object" && !Array.isArray(node[key])) {
        walk(node[key], `${prefix}${key}.`, depth + 1);
      } else if (USAGE_COUNTERS.has(key)) {
        const counter = node[key];
        if (typeof counter === "number" && Number.isSafeInteger(counter) && counter >= 0) {
          result[`${prefix}${key}`] = counter;
        }
      }
      // Any other key is ignored rather than recorded.
    }
  };
  walk(value, "", 0);
  return result;
}

async function probeOnce(config) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  const result = {
    http_status: null,
    latency_ms: 0,
    finish_reason: null,
    usage: {},
    done_seen: false,
    outcome: "error",
    error_code: null,
  };

  try {
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${config.token}`,
      },
      body: JSON.stringify({
        model: config.model,
        stream: true,
        stream_options: { include_usage: true },
        max_tokens: config.maxOutputTokens,
        messages: [{ role: "user", content: config.prompt }],
      }),
      signal: controller.signal,
      redirect: "error",
    });
    result.http_status = response.status;

    if (!response.ok) {
      result.outcome = "http_error";
      result.error_code = "http_status";
      try {
        await response.body?.cancel();
      } catch {
        // Body content is never read or recorded.
      }
      return result;
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      result.outcome = "stream_error";
      result.error_code = "empty_body";
      return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let streamBytes = 0;
    let streamError = null;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        streamBytes += value.byteLength;
        if (streamBytes > MAX_STREAM_BYTES) {
          streamError = "stream_too_large";
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_SSE_LINE_BYTES) {
          streamError = "sse_line_too_large";
          break;
        }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const raw = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          if (!line.startsWith("data:")) continue;
          let data = line.slice(5);
          if (data.startsWith(" ")) data = data.slice(1);
          data = data.trim();
          if (!data) continue;
          if (data === "[DONE]") {
            result.done_seen = true;
            continue;
          }
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch {
            streamError = "invalid_sse_json";
            break;
          }
          if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
            streamError = "invalid_sse_payload";
            break;
          }
          // Extract only bounded, sanitized completion metadata. Content,
          // reasoning, tool data, ids and any other payload are ignored.
          if (Array.isArray(chunk.choices)) {
            for (const choice of chunk.choices) {
              if (choice && typeof choice.finish_reason === "string" && choice.finish_reason) {
                result.finish_reason = sanitizeFinishReason(choice.finish_reason);
              }
            }
          }
          if (chunk.usage !== undefined) result.usage = sanitizeUsage(chunk.usage);
        }
        if (streamError) break;
      }
    } catch {
      streamError = controller.signal.aborted ? "timeout" : "stream_read_error";
    } finally {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation failures; no data is retained.
      }
      try {
        reader.releaseLock();
      } catch {
        // Ignore lock release failures.
      }
    }

    if (streamError) {
      result.outcome = streamError === "timeout" ? "timeout" : "stream_error";
      result.error_code = streamError;
      return result;
    }
    if (!result.done_seen) {
      result.outcome = "stream_error";
      result.error_code = "missing_done";
      return result;
    }
    result.outcome = "ok";
    return result;
  } catch {
    result.outcome = controller.signal.aborted ? "timeout" : "unreachable";
    result.error_code = controller.signal.aborted ? "timeout" : "unreachable";
    return result;
  } finally {
    clearTimeout(timer);
    result.latency_ms = Date.now() - started;
  }
}

function writeEvidence(outPath, evidence) {
  const absolute = path.resolve(process.cwd(), outPath);
  if (fs.existsSync(absolute)) {
    const error = new Error("evidence output exists");
    error.code = "EEXIST";
    throw error;
  }
  fs.writeFileSync(absolute, `${JSON.stringify(evidence, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    fs.chmodSync(absolute, 0o600);
  } catch {
    // Windows does not fully enforce POSIX modes; the mode option above is the
    // portable request. The evidence file remains non-executable.
  }
  return absolute;
}

function printSummary(config, evidence, outPath) {
  const label = sanitizeTestName(config.model, 64);
  const last = evidence.calls[evidence.calls.length - 1] || {};
  const usage = Object.keys(last.usage || {}).length
    ? Object.entries(last.usage).map(([key, value]) => `${key}=${value}`).join(", ")
    : "usage=unreported";
  console.log(`live-check ${evidence.overall} (${label})`);
  console.log(
    `endpoint ${config.endpointHostPort}; calls ${evidence.calls_completed}/${evidence.calls_attempted}; ` +
      `HTTP ${last.http_status ?? "n/a"}; ${last.latency_ms ?? "n/a"} ms; ` +
      `finish_reason=${last.finish_reason ?? "none"}; [DONE]=${last.done_seen ? "yes" : "no"}; ${usage}`
  );
  console.log(`evidence ${outPath}`);
  if (evidence.overall === "unreachable") console.log("bridge unreachable; stopped without retrying");
  else if (evidence.overall === "stopped") console.log(`stopped after failure: ${evidence.stop_reason}`);
}

function printUsage() {
  console.log("Usage: node live-check.cjs --confirm [--base URL] [--model ALIAS] [--out PATH]");
  console.log("Requires BRIDGE_LIVE_APPROVAL, BRIDGE_LIVE_MAX_CALLS (1-3), BRIDGE_LIVE_MAX_OUTPUT_TOKENS (1-512).");
  console.log("Never prints or records the token, prompt, headers, response bodies or tool data.");
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseCli(argv);
  if (!parsed.ok) {
    console.error(`live-check refused: ${parsed.reason}`);
    return 2;
  }
  if (parsed.options.help) {
    printUsage();
    return 0;
  }

  const guard = validateApproval(process.env, argv);
  if (!guard.ok) {
    console.error(`live-check refused: ${guard.message}`);
    return 2;
  }
  const config = guard.config;

  if (typeof fetch !== "function") {
    console.error("live-check refused: this Node runtime has no global fetch");
    return 2;
  }

  const resolvedOut = path.resolve(process.cwd(), config.outPath);
  if (fs.existsSync(resolvedOut)) {
    console.error("live-check refused: evidence output already exists; refusing to overwrite");
    return 2;
  }

  const calls = [];
  let stopReason = null;
  for (let index = 0; index < config.maxCalls; index += 1) {
    const result = await probeOnce(config);
    calls.push({ call: index + 1, ...result });
    if (result.outcome !== "ok") {
      stopReason = result.error_code || result.outcome;
      break;
    }
  }

  const completed = calls.filter((call) => call.outcome === "ok").length;
  const unreachable = calls.some((call) => call.outcome === "unreachable");
  const overall = completed === config.maxCalls ? "completed" : unreachable ? "unreachable" : "stopped";
  const evidence = {
    schema: "azure-bridge/live-evidence/v1",
    recorded_at_utc: new Date().toISOString(),
    approval_reference: config.approval,
    endpoint_host_port: config.endpointHostPort,
    model_alias: config.model,
    limits: {
      max_calls: config.maxCalls,
      max_output_tokens: config.maxOutputTokens,
      timeout_ms: config.timeoutMs,
      remote_allowed: config.allowRemote,
    },
    calls_attempted: calls.length,
    calls_completed: completed,
    overall,
    stop_reason: stopReason,
    calls,
  };

  let written;
  try {
    written = writeEvidence(config.outPath, evidence);
  } catch {
    console.error("live-check failed: cannot write evidence file (refusing to overwrite or write error)");
    return 1;
  }

  printSummary(config, evidence, written);
  return overall === "completed" ? 0 : 1;
}

if (require.main === module) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch(() => {
      console.error("live-check failed: internal error (no evidence written)");
      process.exitCode = 1;
    });
}

module.exports = {
  validateApproval,
  sanitizeTestName,
  parseCli,
  isLoopbackHost,
  normalizeChatEndpoint,
  endpointHostPort,
  sanitizeFinishReason,
  sanitizeUsage,
};
