"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

// Load local secrets when present; explicit process environment values take precedence.
try {
  process.loadEnvFile(path.join(__dirname, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const CONFIG = {
  host: "127.0.0.1",
  port: Number(process.env.BRIDGE_PORT || 8787),
  azureBase: process.env.AZURE_OPENAI_BASE || "",
  azureApiKey: process.env.AZURE_OPENAI_API_KEY || "",
  proxyToken: process.env.BRIDGE_PROXY_TOKEN || "",
  defaultModel: process.env.AZURE_OPENAI_MODEL || "gpt-6-luna",
  logPath: path.join(__dirname, "bridge.log"),
  maxBodyBytes: 1024 * 1024,
  maxLogBytes: 10 * 1024 * 1024,
  // Idle timeout for the upstream Azure request. Any received activity
  // (headers or stream bytes) re-arms it, so long streams are not cut off.
  requestTimeoutMs: 5 * 60 * 1000,
};

const serverStartedAt = Math.floor(Date.now() / 1000);

function localTimestamp(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(Math.abs(offsetMinutes) / 60)).padStart(2, "0");
  const offsetRemainder = String(Math.abs(offsetMinutes) % 60).padStart(2, "0");
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part, index) => String(part).padStart(index === 0 ? 4 : 2, "0"))
    .join("-");
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
  const milliseconds = String(date.getMilliseconds()).padStart(3, "0");
  return `${datePart}T${timePart}.${milliseconds}${sign}${offsetHours}:${offsetRemainder}`;
}

function log(event, fields = {}) {
  const line = JSON.stringify({
    time: localTimestamp(),
    event,
    ...fields,
  });
  process.stdout.write(`${line}\n`);

  try {
    if (fs.existsSync(CONFIG.logPath) && fs.statSync(CONFIG.logPath).size >= CONFIG.maxLogBytes) {
      const oldPath = `${CONFIG.logPath}.old`;
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      fs.renameSync(CONFIG.logPath, oldPath);
    }
    fs.appendFileSync(CONFIG.logPath, `${line}\n`, "utf8");
  } catch (error) {
    process.stderr.write(`Unable to write bridge log: ${error.message}\n`);
  }
}

function sendJson(res, status, value) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function openAiError(message, type = "proxy_error", code = null) {
  return { error: { message, type, code } };
}

function constantTimeEqual(left, right) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function hasProxyAuth(req) {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || "");
  return Boolean(CONFIG.proxyToken && match && constantTimeEqual(match[1], CONFIG.proxyToken));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];

    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > CONFIG.maxBodyBytes) {
        tooLarge = true;
        chunks.length = 0;
        // Keep consuming the request so the caller can receive the 413 response.
        reject(Object.assign(new Error("Request body exceeds 1 MiB"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(Object.assign(new Error("Request body must be valid JSON"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

function contentToInput(content, textType = "input_text") {
  if (typeof content === "string") {
    return [{ type: textType, text: content }];
  }
  if (content == null) return [];
  if (!Array.isArray(content)) {
    throw Object.assign(new Error("Message content must be a string or an array"), { status: 400 });
  }

  const converted = [];
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") {
      converted.push({ type: textType, text: part.text });
    } else if (part && part.type === "image_url") {
      const imageUrl = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (!imageUrl) {
        throw Object.assign(new Error("Image content must include an image_url"), { status: 400 });
      }
      converted.push({ type: "input_image", image_url: imageUrl });
    } else {
      throw Object.assign(new Error(`Unsupported message content type: ${String(part?.type)}`), { status: 400 });
    }
  }
  return converted;
}

function normalizeArguments(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

function mapToolChoice(choice) {
  if (typeof choice === "string") return choice;
  if (choice && choice.type === "function" && choice.function?.name) {
    return { type: "function", name: choice.function.name };
  }
  return undefined;
}

function toResponsesRequest(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.messages)) {
    throw Object.assign(new Error("messages must be an array"), { status: 400 });
  }

  const instructions = [];
  const input = [];

  for (const message of body.messages) {
    if (!message || typeof message !== "object") continue;
    const role = message.role;

    if (role === "system" || role === "developer") {
      const text = typeof message.content === "string"
        ? message.content
        : contentToInput(message.content).map((part) => part.text || "").join("");
      instructions.push(`[${role}]\n${text}`);
      continue;
    }

    if (role === "user" || role === "assistant") {
      const content = contentToInput(message.content, role === "assistant" ? "output_text" : "input_text");
      if (content.length || !Array.isArray(message.tool_calls)) {
        input.push({ role, content });
      }
      if (role === "assistant" && Array.isArray(message.tool_calls)) {
        for (const toolCall of message.tool_calls) {
          if (toolCall?.type !== "function" || !toolCall.function?.name) continue;
          input.push({
            type: "function_call",
            call_id: toolCall.id,
            name: toolCall.function.name,
            arguments: normalizeArguments(toolCall.function.arguments),
          });
        }
      }
      continue;
    }

    if (role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: typeof message.content === "string"
          ? message.content
          : JSON.stringify(message.content ?? ""),
      });
      continue;
    }

    throw Object.assign(new Error(`Unsupported message role: ${String(role)}`), { status: 400 });
  }

  const request = {
    model: typeof body.model === "string" && body.model ? body.model : CONFIG.defaultModel,
    input,
    stream: body.stream === true,
  };
  if (instructions.length) request.instructions = instructions.join("\n\n");

  if (Array.isArray(body.tools)) {
    request.tools = body.tools
      .filter((tool) => tool?.type === "function" && tool.function?.name)
      .map((tool) => ({
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        ...(tool.function.strict !== undefined ? { strict: tool.function.strict } : {}),
      }));
  }

  const toolChoice = mapToolChoice(body.tool_choice);
  if (toolChoice !== undefined) request.tool_choice = toolChoice;
  if (typeof body.parallel_tool_calls === "boolean") request.parallel_tool_calls = body.parallel_tool_calls;

  const effort = body.reasoning_effort;
  if (typeof effort === "string" && effort !== "none") {
    request.reasoning = { effort, summary: "auto" };
  }

  const maxOutputTokens = body.max_completion_tokens ?? body.max_tokens;
  if (Number.isInteger(maxOutputTokens) && maxOutputTokens > 0) {
    request.max_output_tokens = maxOutputTokens;
  }
  if (typeof body.temperature === "number") request.temperature = body.temperature;
  if (typeof body.top_p === "number") request.top_p = body.top_p;

  return request;
}

function mapUsage(usage) {
  if (!usage || typeof usage !== "object") return undefined;
  const mapped = {
    prompt_tokens: usage.input_tokens || 0,
    completion_tokens: usage.output_tokens || 0,
    total_tokens: usage.total_tokens || 0,
  };
  const reasoningTokens = usage.output_tokens_details?.reasoning_tokens;
  if (reasoningTokens !== undefined) {
    mapped.completion_tokens_details = { reasoning_tokens: reasoningTokens };
  }
  const cachedTokens = usage.input_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined) mapped.prompt_tokens_details = { cached_tokens: cachedTokens };
  return mapped;
}

function extractResponse(response) {
  const textParts = [];
  const reasoningParts = [];
  const toolCalls = [];

  for (const item of response.output || []) {
    if (item.type === "message") {
      for (const part of item.content || []) {
        if (part.type === "output_text" && typeof part.text === "string") textParts.push(part.text);
        if (part.type === "refusal" && typeof part.refusal === "string") textParts.push(part.refusal);
      }
    } else if (item.type === "reasoning") {
      for (const part of item.summary || []) {
        if (typeof part.text === "string") reasoningParts.push(part.text);
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.call_id || item.id,
        type: "function",
        function: { name: item.name, arguments: normalizeArguments(item.arguments) },
      });
    }
  }

  const message = {
    role: "assistant",
    content: textParts.length ? textParts.join("") : null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  if (reasoningParts.length) message.reasoning_content = reasoningParts.join("");

  const status = response.status;
  const incompleteReason = response.incomplete_details?.reason;
  const finishReason = toolCalls.length
    ? "tool_calls"
    : status === "incomplete" && incompleteReason === "max_output_tokens"
      ? "length"
      : status === "incomplete" && incompleteReason === "content_filter"
        ? "content_filter"
        : "stop";

  return {
    id: `chatcmpl-${response.id || crypto.randomUUID()}`,
    object: "chat.completion",
    created: Number.isInteger(response.created_at) ? response.created_at : serverStartedAt,
    model: response.model || CONFIG.defaultModel,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    ...(mapUsage(response.usage) ? { usage: mapUsage(response.usage) } : {}),
  };
}

async function parseUpstreamError(response) {
  let value;
  try {
    value = await response.json();
  } catch {
    return openAiError(`Azure returned HTTP ${response.status}`, "upstream_error", String(response.status));
  }
  const source = value?.error || value;
  return openAiError(
    typeof source?.message === "string" ? source.message : `Azure returned HTTP ${response.status}`,
    source?.type || "upstream_error",
    source?.code ?? String(response.status),
  );
}

function initSse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
}

function writeSse(res, value) {
  const data = typeof value === "string" ? value : JSON.stringify(value);
  if (res.destroyed || res.writableEnded) return true;
  return res.write(`data: ${data}\n\n`);
}

async function streamResponse(upstream, res, requestedModel, onActivity) {
  initSse(res);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const toolIndices = new Map();
  let nextToolIndex = 0;
  let chatId = `chatcmpl-${crypto.randomUUID()}`;
  let created = serverStartedAt;
  let model = requestedModel || CONFIG.defaultModel;
  let roleSent = false;
  let terminal = false;
  let sawFunctionCall = false;
  let finishReason = "stop";
  let buffer = "";
  let eventName = "";
  let dataLines = [];

  const chunk = (choice, usage) => ({
    id: chatId,
    object: "chat.completion.chunk",
    created,
    model,
    choices: choice ? [{ index: 0, ...choice }] : [],
    ...(usage ? { usage } : {}),
  });
  const waitForDrain = () => new Promise((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      res.off("error", done);
      resolve();
    };
    // Pause upstream parsing until the downstream client has caught up.
    res.once("drain", done);
    res.once("close", done);
    res.once("error", done);
  });
  const emit = async (value) => {
    if (!writeSse(res, value) && !res.destroyed) await waitForDrain();
  };
  const ensureRole = async () => {
    if (!roleSent) {
      await emit(chunk({ delta: { role: "assistant" }, finish_reason: null }));
      roleSent = true;
    }
  };
  const finish = async (usage) => {
    if (terminal) return;
    terminal = true;
    await ensureRole();
    await emit(chunk({ delta: {}, finish_reason: finishReason }));
    if (usage) await emit(chunk(null, usage));
    await emit("[DONE]");
    res.end();
  };
  const fail = async (error) => {
    if (terminal) return;
    terminal = true;
    await emit(openAiError(error.message || "Azure stream failed", "upstream_error", error.code || null));
    await emit("[DONE]");
    res.end();
  };

  async function handleEvent(name, rawData) {
    if (!rawData || rawData === "[DONE]") return;
    let payload;
    try {
      payload = JSON.parse(rawData);
    } catch {
      log("invalid_sse_json", { event: name });
      return;
    }

    if (name === "response.created") {
      const response = payload.response || {};
      if (response.id) chatId = `chatcmpl-${response.id}`;
      if (Number.isInteger(response.created_at)) created = response.created_at;
      if (typeof response.model === "string") model = response.model;
      await ensureRole();
      return;
    }

    if (name === "response.output_item.added") {
      const item = payload.item || {};
      if (item.type !== "function_call") return;
      const outputIndex = payload.output_index;
      if (!toolIndices.has(outputIndex)) toolIndices.set(outputIndex, nextToolIndex++);
      const index = toolIndices.get(outputIndex);
      sawFunctionCall = true;
      await ensureRole();
      await emit(chunk({
        delta: {
          tool_calls: [{
            index,
            id: item.call_id || item.id,
            type: "function",
            function: { name: item.name, arguments: "" },
          }],
        },
        finish_reason: null,
      }));
      return;
    }

    if (name === "response.output_text.delta" || name === "response.refusal.delta") {
      await ensureRole();
      await emit(chunk({ delta: { content: payload.delta || "" }, finish_reason: null }));
      return;
    }

    if (name === "response.reasoning_summary_text.delta") {
      await ensureRole();
      await emit(chunk({ delta: { reasoning_content: payload.delta || "" }, finish_reason: null }));
      return;
    }

    if (name === "response.function_call_arguments.delta") {
      const index = toolIndices.get(payload.output_index);
      if (index === undefined) {
        log("tool_delta_without_item", { outputIndex: payload.output_index });
        return;
      }
      await ensureRole();
      await emit(chunk({
        delta: {
          tool_calls: [{ index, function: { arguments: payload.delta || "" } }],
        },
        finish_reason: null,
      }));
      return;
    }

    if (name === "response.incomplete") {
      const response = payload.response || {};
      const reason = response.incomplete_details?.reason;
      finishReason = reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "content_filter" : "stop";
      await finish(mapUsage(response.usage));
      return;
    }

    if (name === "response.completed") {
      const response = payload.response || {};
      if (response.status === "incomplete") {
        const reason = response.incomplete_details?.reason;
        finishReason = reason === "max_output_tokens" ? "length" : reason === "content_filter" ? "content_filter" : "stop";
      } else {
        finishReason = sawFunctionCall ? "tool_calls" : "stop";
      }
      await finish(mapUsage(response.usage));
      return;
    }

    if (name === "response.failed" || name === "error") {
      const error = payload.response?.error || payload.error || payload;
      await fail(error);
      return;
    }

    log("unknown_sse_event", { event: name });
  }

  async function handleLine(line) {
    if (line === "") {
      if (dataLines.length) await handleEvent(eventName, dataLines.join("\n"));
      eventName = "";
      dataLines = [];
      return;
    }
    if (line.startsWith(":")) return;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }

  try {
    while (!terminal) {
      const { value, done } = await reader.read();
      if (done) break;
      if (onActivity) onActivity();
      buffer += decoder.decode(value, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        await handleLine(line);
        if (terminal) break;
      }
    }
    if (!terminal) {
      buffer += decoder.decode();
      if (buffer) await handleLine(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      if (dataLines.length) await handleEvent(eventName, dataLines.join("\n"));
      if (!terminal) await fail(new Error("Azure SSE ended before a terminal response event"));
    }
  } catch (error) {
    if (!res.destroyed) await fail(error);
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

async function handleChatCompletion(req, res, url) {
  if (!CONFIG.proxyToken) {
    sendJson(res, 503, openAiError("BRIDGE_PROXY_TOKEN is not configured", "proxy_configuration_error"));
    return;
  }
  if (!hasProxyAuth(req)) {
    sendJson(res, 401, openAiError("Invalid or missing local proxy credential", "authentication_error"));
    return;
  }
  if (!CONFIG.azureApiKey) {
    sendJson(res, 503, openAiError("AZURE_OPENAI_API_KEY is not configured", "proxy_configuration_error"));
    return;
  }
  if (!CONFIG.azureBase) {
    sendJson(res, 503, openAiError("AZURE_OPENAI_BASE is not configured", "proxy_configuration_error"));
    return;
  }

  const body = await readJsonBody(req);
  const payload = toResponsesRequest(body);
  const upstreamUrl = new URL("/openai/v1/responses", CONFIG.azureBase);
  const controller = new AbortController();
  let timeout;
  // Idle timeout: re-armed on upstream headers and on every streamed byte,
  // so only a genuinely stalled upstream is aborted, not a long active stream.
  const armTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(new Error("Azure request timed out")), CONFIG.requestTimeoutMs);
  };
  armTimeout();
  const abortOnClose = () => {
    if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
  };
  res.on("close", abortOnClose);

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": payload.stream ? "text/event-stream" : "application/json",
        "api-key": CONFIG.azureApiKey,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    armTimeout();

    if (!upstream.ok) {
      const error = await parseUpstreamError(upstream);
      sendJson(res, upstream.status, error);
      return;
    }

    if (payload.stream) {
      if (!upstream.body) {
        sendJson(res, 502, openAiError("Azure returned an empty stream", "upstream_error"));
        return;
      }
      await streamResponse(upstream, res, payload.model, armTimeout);
      return;
    }

    const response = await upstream.json();
    if (response.status === "failed") {
      const error = response.error || {};
      sendJson(res, 502, openAiError(error.message || "Azure response failed", error.type || "upstream_error", error.code || null));
      return;
    }
    sendJson(res, 200, extractResponse(response));
  } catch (error) {
    const status = controller.signal.aborted ? 504 : 502;
    if (res.headersSent && !res.destroyed) {
      if (!res.writableEnded) {
        writeSse(res, openAiError(error.message || "Azure request failed", "upstream_error"));
        writeSse(res, "[DONE]");
        res.end();
      }
    } else {
      sendJson(res, status, openAiError(error.message || "Azure request failed", "upstream_error"));
    }
  } finally {
    clearTimeout(timeout);
    res.off("close", abortOnClose);
  }
}

const server = http.createServer(async (req, res) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url, `http://${CONFIG.host}:${CONFIG.port}`).pathname;
    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "GET" && pathname === "/v1/models") {
      sendJson(res, 200, {
        object: "list",
        data: [{ id: CONFIG.defaultModel, object: "model", created: serverStartedAt, owned_by: "azure" }],
      });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/chat/completions") {
      await handleChatCompletion(req, res);
      return;
    }
    sendJson(res, 404, openAiError("Not found", "invalid_request_error"));
  } catch (error) {
    sendJson(res, error.status || 500, openAiError(error.message || "Internal proxy error", "proxy_error"));
  } finally {
    log("request", { method: req.method, path: pathname, status: res.statusCode });
  }
});

server.requestTimeout = CONFIG.requestTimeoutMs;
server.headersTimeout = 15_000;
server.listen(CONFIG.port, CONFIG.host, () => {
  log("listening", { host: CONFIG.host, port: CONFIG.port });
});
server.on("error", (error) => {
  log("server_error", { message: error.message, code: error.code });
  process.exitCode = 1;
});
