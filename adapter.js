"use strict";
const { isStandardField, normalizeChatDefaults, CHAT_CONTENT_TYPES, WORKBUDDY_MESSAGE_FIELDS,
  RESERVED_MESSAGE_FIELDS, ADAPTER_MESSAGE_FIELDS, isBoundedMetadataKey } = require("./chat-contract");

// Stateless protocol translation only: importing this module performs no I/O.
class BridgeError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "BridgeError";
    this.status = options.status ?? 400;
    this.type = options.type ?? "invalid_request_error";
    this.code = options.code ?? "invalid_parameter";
    this.param = options.param ?? null;
  }
}

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (param, message) => { throw new BridgeError(message, { param }); };
const unsupported = (param, message) => { throw new BridgeError(message, { param, code: "unsupported_parameter" }); };
const upstreamFail = (message) => {
  throw new BridgeError(message, { status: 502, type: "upstream_error", code: "invalid_upstream_response" });
};
function fields(value, allowed, param) {
  if (!object(value)) fail(param, `${param} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      if (isStandardField(param, value, key)) unsupported(`${param}.${key}`, `Standard Chat Completions field ${param}.${key} is not implemented by this GPT-6 Responses adapter`);
      throw new BridgeError(`Unknown request field: ${param}.${key}`, { param: `${param}.${key}`, code: "unknown_parameter" });
    }
  }
}
function string(value, param, max = Infinity, empty = false) {
  if (typeof value !== "string" || (!empty && !value.trim()) || value.length > max) {
    fail(param, `${param} must be ${empty ? "a" : "a nonempty"} string${max < Infinity ? ` of at most ${max} characters` : ""}`);
  }
  return value;
}
function boolean(value, param) {
  if (typeof value !== "boolean") fail(param, `${param} must be a boolean`);
  return value;
}
function positiveInteger(value, param) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(param, `${param} must be a positive integer`);
  return value;
}
function choice(value, values, param) {
  if (!Array.isArray(values) || !values.includes(value)) fail(param, `Unsupported ${param}`);
  return value;
}
function jsonClone(value, param) {
  // Accept JSON data, not values JSON.stringify would silently discard/coerce.
  const seen = new Set();
  const copy = (node, depth) => {
    if (depth > 100) fail(param, `${param} exceeds the supported nesting depth`);
    if (node === null || typeof node === "string" || typeof node === "boolean") return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if (typeof node !== "object" || seen.has(node)) fail(param, `${param} must contain valid JSON data`);
    if (!Array.isArray(node) && Object.getPrototypeOf(node) !== Object.prototype && Object.getPrototypeOf(node) !== null) {
      fail(param, `${param} must contain plain JSON objects`);
    }
    seen.add(node);
    const result = Array.isArray(node) ? node.map((item) => copy(item, depth + 1)) : {};
    if (!Array.isArray(node)) {
      for (const key of Object.keys(node)) {
        Object.defineProperty(result, key, { value: copy(node[key], depth + 1), enumerable: true, writable: true, configurable: true });
      }
    }
    seen.delete(node);
    return result;
  };
  return copy(value, 0);
}
function functionName(value, param) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(value)) fail(param, `${param} must be a valid function name`);
  return value;
}
function callId(value, param) {
  if (typeof value !== "string" || !/^[^\s\u0000-\u001f\u007f]{1,512}$/.test(value)) fail(param, `${param} must be a nonempty call ID`);
  return value;
}
function argumentsString(value, param) {
  if (typeof value !== "string") fail(param, `${param} must be a JSON object encoded as a string`);
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(param, `${param} must be valid JSON`); }
  if (!object(parsed)) fail(param, `${param} must encode a JSON object`);
  return value;
}

function strictSchema(schema, param) {
  const walk = (node, path) => {
    if (typeof node === "boolean") fail(path, "Boolean schemas are not supported in strict mode");
    if (!object(node)) fail(path, `${path} must be a schema object`);
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes("object") || own(node, "properties")) {
      if (node.additionalProperties !== false) fail(path, "Strict object schemas require additionalProperties:false");
      if (own(node, "properties") && !object(node.properties)) fail(`${path}.properties`, "properties must be an object");
      const names = Object.keys(node.properties || {});
      if (!Array.isArray(node.required) || node.required.length !== names.length || new Set(node.required).size !== names.length || names.some((name) => !node.required.includes(name))) {
        fail(path, "Strict object schemas require every property (use nullable types for optional values)");
      }
    }
    for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
      if (own(node, key)) {
        if (!object(node[key])) fail(`${path}.${key}`, `${key} must be an object`);
        for (const [name, child] of Object.entries(node[key])) walk(child, `${path}.${key}.${name}`);
      }
    }
    for (const key of ["items", "contains", "not", "if", "then", "else", "additionalProperties"]) {
      if (own(node, key) && typeof node[key] !== "boolean") {
        if (Array.isArray(node[key])) node[key].forEach((child, index) => walk(child, `${path}.${key}[${index}]`));
        else walk(node[key], `${path}.${key}`);
      }
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      if (own(node, key)) {
        if (!Array.isArray(node[key]) || !node[key].length) fail(`${path}.${key}`, `${key} must be a nonempty array`);
        node[key].forEach((child, index) => walk(child, `${path}.${key}[${index}]`));
      }
    }
  };
  walk(schema, param);
}
function validateSchemaKeywords(schema, param) {
  const walk = (node, path) => {
    if (typeof node === "boolean") return;
    if (!object(node)) fail(path, "JSON schema nodes must be objects or booleans");
    if (own(node, "type")) {
      const values = Array.isArray(node.type) ? node.type : [node.type];
      if (!values.length || new Set(values).size !== values.length || values.some((value) => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(value))) fail(`${path}.type`, "Invalid JSON schema type");
    }
    if (own(node, "required") && (!Array.isArray(node.required) || new Set(node.required).size !== node.required.length || node.required.some((name) => typeof name !== "string"))) fail(`${path}.required`, "Schema required must be an array of unique strings");
    for (const key of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]) {
      if (!own(node, key)) continue;
      if (!object(node[key])) fail(`${path}.${key}`, `Schema ${key} must be an object`);
      for (const [name, child] of Object.entries(node[key])) walk(child, `${path}.${key}.${name}`);
    }
    for (const key of ["items", "contains", "not", "if", "then", "else", "additionalProperties", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]) {
      if (!own(node, key)) continue;
      if (Array.isArray(node[key]) && key === "items") node[key].forEach((child, index) => walk(child, `${path}.${key}[${index}]`));
      else walk(node[key], `${path}.${key}`);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      if (!own(node, key)) continue;
      if (!Array.isArray(node[key]) || !node[key].length) fail(`${path}.${key}`, `Schema ${key} must be a nonempty array`);
      node[key].forEach((child, index) => walk(child, `${path}.${key}[${index}]`));
    }
    for (const key of ["$ref", "$id", "$schema", "pattern", "format", "title", "description"]) if (own(node, key) && typeof node[key] !== "string") fail(`${path}.${key}`, `Schema ${key} must be a string`);
    if (own(node, "enum") && (!Array.isArray(node.enum) || !node.enum.length)) fail(`${path}.enum`, "Schema enum must be a nonempty array");
  };
  walk(schema, param);
}
function schemaObject(value, param, strict) {
  if (!object(value)) fail(param, `${param} must be a JSON schema object`);
  if (value.type !== "object") unsupported(param, "This standard schema shape is not implemented: the bridge supports root object schemas only");
  const schema = jsonClone(value, param);
  validateSchemaKeywords(schema, param);
  if (strict) strictSchema(schema, param);
  return schema;
}
function cacheOptions(value, param) {
  fields(value, ["mode", "ttl"], param);
  if (own(value, "mode")) choice(value.mode, ["implicit", "explicit"], `${param}.mode`);
  if (own(value, "ttl")) choice(value.ttl, ["30m"], `${param}.ttl`);
  return { ...(own(value, "mode") ? { mode: value.mode } : {}), ...(own(value, "ttl") ? { ttl: value.ttl } : {}) };
}
function breakpoint(value, profile, param) {
  if (profile.cacheBreakpoints !== true || profile.deploymentType === "ptu-m") fail(param, "Explicit cache breakpoints are not supported by this deployment profile");
  fields(value, ["mode"], param);
  choice(value.mode, ["explicit"], `${param}.mode`);
  return { mode: "explicit" };
}
function contentParts(content, role, profile, param, nullable = false) {
  if (content === null && nullable) return [];
  if (typeof content === "string") return [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  if (!Array.isArray(content) || !content.length) fail(param, `${param} must be a string or nonempty content array`);
  return content.map((part, index) => {
    const path = `${param}[${index}]`;
    if (!object(part)) fail(path, "Content blocks must be objects");
    if (part.type === "text") {
      // `annotations` is a bridge output extension (safe citations). Clients may
      // echo it back on the assistant content block; accept it as bounded
      // metadata and never forward or re-interpret it as request semantics.
      fields(part, ["type", "text", "prompt_cache_breakpoint", "annotations"], path);
      if (own(part, "annotations")) validateClientMetadata(part.annotations, `${path}.annotations`);
      const result = { type: role === "assistant" ? "output_text" : "input_text", text: string(part.text, `${path}.text`, Infinity, true) };
      if (own(part, "prompt_cache_breakpoint")) {
        if (role === "assistant") fail(`${path}.prompt_cache_breakpoint`, "Cache breakpoints are supported on input content only");
        result.prompt_cache_breakpoint = breakpoint(part.prompt_cache_breakpoint, profile, `${path}.prompt_cache_breakpoint`);
      }
      return result;
    }
    if (part.type === "image_url") {
      if (role !== "user" || profile.images !== true) unsupported(path, "Standard image input is not enabled for this role/deployment profile");
      fields(part, ["type", "image_url", "prompt_cache_breakpoint"], path);
      fields(part.image_url, ["url", "detail"], `${path}.image_url`);
      const url = string(part.image_url.url, `${path}.image_url.url`);
      let valid = false;
      try {
        const parsed = new URL(url);
        valid = (parsed.protocol === "https:" || parsed.protocol === "http:") && !parsed.username && !parsed.password;
      } catch { /* A base64 data URL is also supported. No URL is fetched locally. */ }
      valid ||= /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(url);
      if (!valid) fail(`${path}.image_url.url`, "Image URL must be HTTP(S) or a base64 image data URL without credentials");
      const result = { type: "input_image", image_url: url };
      if (own(part.image_url, "detail")) {
        if (part.image_url.detail === "original") unsupported(`${path}.image_url.detail`, "Original image detail is standard but not verified/enabled in this bridge profile");
        result.detail = choice(part.image_url.detail, ["auto", "low", "high"], `${path}.image_url.detail`);
      }
      if (own(part, "prompt_cache_breakpoint")) result.prompt_cache_breakpoint = breakpoint(part.prompt_cache_breakpoint, profile, `${path}.prompt_cache_breakpoint`);
      return result;
    }
    if (part.type === "refusal" && role === "assistant") {
      fields(part, ["type", "refusal", "annotations"], path);
      if (own(part, "annotations")) validateClientMetadata(part.annotations, `${path}.annotations`);
      return { type: "refusal", refusal: string(part.refusal, `${path}.refusal`, Infinity, true) };
    }
    if (CHAT_CONTENT_TYPES.includes(part.type)) unsupported(`${path}.type`, "This standard Chat content variant is not implemented for this role/deployment");
    fail(`${path}.type`, "Unknown or invalid Chat content type");
  });
}
function toolOutput(content, param) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content) || !content.length) fail(param, "Tool output must be text or a nonempty array of text blocks");
  return content.map((part, index) => {
    const path = `${param}[${index}]`;
    fields(part, ["type", "text"], path);
    choice(part.type, ["text"], `${path}.type`);
    return string(part.text, `${path}.text`, Infinity, true);
  }).join("");
}

const CLIENT_METADATA_LIMITS = Object.freeze({ bytes: 64 * 1024, depth: 16, nodes: 4096 });
function validateClientMetadata(value, param) {
  let bytes = 0, nodes = 0; const active = new Set();
  const add = count => { bytes += count; if (bytes > CLIENT_METADATA_LIMITS.bytes) fail(param, "Client metadata exceeds the 64 KiB limit"); };
  const encodedString = text => {
    if (text.length > CLIENT_METADATA_LIMITS.bytes) fail(param, "Client metadata exceeds the 64 KiB limit");
    return Buffer.byteLength(JSON.stringify(text));
  };
  const walk = (node, depth) => {
    if (++nodes > CLIENT_METADATA_LIMITS.nodes || depth > CLIENT_METADATA_LIMITS.depth) fail(param, "Client metadata exceeds the supported structural limit");
    if (node === null) { add(4); return; }
    if (typeof node === "boolean") { add(node ? 4 : 5); return; }
    if (typeof node === "string") { add(encodedString(node)); return; }
    if (typeof node === "number" && Number.isFinite(node)) { add(JSON.stringify(node).length); return; }
    if (!object(node) && !Array.isArray(node)) fail(param, "Client metadata must contain JSON data only");
    if (active.has(node)) fail(param, "Client metadata must not contain cycles");
    if (!Array.isArray(node) && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) fail(param, "Client metadata must contain plain JSON objects");
    if (Object.getOwnPropertySymbols(node).length) fail(param, "Client metadata must contain JSON keys only");
    active.add(node);
    if (Array.isArray(node)) {
      if (node.length > CLIENT_METADATA_LIMITS.nodes || Object.keys(node).some(key => !/^\d+$/.test(key))) fail(param, "Client metadata array is not supported JSON data");
      add(2 + Math.max(0, node.length - 1));
      for (let i = 0; i < node.length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(node, String(i));
        if (!descriptor || !own(descriptor, "value")) fail(param, "Client metadata must not contain accessors or sparse arrays");
        walk(descriptor.value, depth + 1);
      }
    } else {
      const descriptors = Object.getOwnPropertyDescriptors(node), keys = Object.keys(descriptors);
      if (keys.length > CLIENT_METADATA_LIMITS.nodes) fail(param, "Client metadata has too many fields");
      add(2 + Math.max(0, keys.length - 1));
      for (const key of keys) {
        if (!own(descriptors[key], "value")) fail(param, "Client metadata must not contain accessors");
        add(encodedString(key) + 1); walk(descriptors[key].value, depth + 1);
      }
    }
    active.delete(node);
  };
  walk(value, 0);
}
function validateStandardScalarShapes(body) {
  for (const key of ["function_call", "functions", "parallel_tool_calls", "prompt_cache_options", "response_format", "tool_choice", "tools", "user", "web_search_options"]) if (own(body, key) && body[key] === null) fail(key, `${key} is not nullable in the standard Chat Completions schema`);
  for (const key of ["frequency_penalty", "presence_penalty"]) if (own(body, key) && body[key] !== null && (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < -2 || body[key] > 2)) fail(key, `${key} must be a finite number from -2 to 2`);
  if (own(body, "logprobs") && body.logprobs !== null) boolean(body.logprobs, "logprobs");
  if (own(body, "top_logprobs") && body.top_logprobs !== null) {
    if (!Number.isSafeInteger(body.top_logprobs) || body.top_logprobs < 0 || body.top_logprobs > 20) fail("top_logprobs", "top_logprobs must be an integer from 0 to 20");
    if (body.logprobs !== true) fail("top_logprobs", "top_logprobs requires logprobs:true, including when alternatives is zero");
  }
  if (own(body, "seed") && body.seed !== null && !Number.isSafeInteger(body.seed)) fail("seed", "seed must be a safe integer");
  if (own(body, "logit_bias") && body.logit_bias !== null) {
    if (!object(body.logit_bias)) fail("logit_bias", "logit_bias must be an object");
    for (const [token, bias] of Object.entries(body.logit_bias)) if (!/^\d+$/.test(token) || typeof bias !== "number" || !Number.isFinite(bias) || bias < -100 || bias > 100) fail("logit_bias", "logit_bias requires token IDs mapped to finite numbers from -100 to 100");
  }
  if (own(body, "modalities") && body.modalities !== null && (!Array.isArray(body.modalities) || !body.modalities.length || new Set(body.modalities).size !== body.modalities.length || body.modalities.some(value => !["text", "audio"].includes(value)))) fail("modalities", "modalities must be a nonempty unique array of text/audio");
  if (own(body, "stop") && body.stop !== null && typeof body.stop !== "string" && (!Array.isArray(body.stop) || body.stop.length > 4 || body.stop.some(value => typeof value !== "string"))) fail("stop", "stop must be a string or up to four strings");
  if (own(body, "service_tier") && body.service_tier !== null) choice(body.service_tier, ["auto", "default", "flex", "scale", "priority", "fast"], "service_tier");
  if (own(body, "prompt_cache_retention") && body.prompt_cache_retention !== null) choice(body.prompt_cache_retention, ["in_memory", "24h"], "prompt_cache_retention");
}
const REQUEST_FIELDS = ["model", "messages", "stream", "stream_options", "n", "tools", "tool_choice", "parallel_tool_calls", "reasoning_effort", "reasoning_mode", "reasoning_context", "max_tokens", "max_completion_tokens", "temperature", "top_p", "response_format", "verbosity", "prompt_cache_key", "prompt_cache_options", "store", "metadata", "user", "safety_identifier"];
function toResponsesRequest(body, config) {
  if (!object(body)) fail("body", "Request body must be an object");
  // Normalize exact inert defaults before shape checks: logprobs:false with
  // top_logprobs:0 is unset, not an enabled logprob request.
  body = normalizeChatDefaults(body).body;
  validateStandardScalarShapes(body);
  fields(body, REQUEST_FIELDS, "body");
  if (!object(config) || !object(config.models)) throw new BridgeError("Model routing is not configured", { status: 503, type: "proxy_configuration_error", code: "invalid_configuration" });
  const alias = own(body, "model") ? string(body.model, "model", 256) : config.defaultModel;
  if (typeof alias !== "string" || !own(config.models, alias)) throw new BridgeError("Unknown model alias", { param: "model", code: "model_not_found" });
  const route = config.models[alias];
  if (!object(route) || typeof route.deployment !== "string" || !route.deployment.trim() || !["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"].includes(route.variant) || typeof route.version !== "string" || !route.version.trim() || !object(route.profile)) throw new BridgeError("Invalid explicit GPT-6 model profile", { status: 503, type: "proxy_configuration_error", code: "invalid_configuration" });
  const profile = route.profile;
  const defaults = config.defaults || {};
  const policy = config.instructionPolicy ?? "preserve";
  choice(policy, ["preserve", "developer", "system", "reject-mixed"], "instructionPolicy");
  choice(config.samplingPolicy ?? "reject", ["reject", "drop-defaults"], "samplingPolicy");
  if (!Array.isArray(body.messages) || !body.messages.length) fail("messages", "messages must be a nonempty array");
  if (own(body, "n")) {
    positiveInteger(body.n, "n");
    if (body.n !== 1) unsupported("n", "Multiple Chat choices are standard but this adapter creates one choice per Azure Response");
  }
  const stream = own(body, "stream") ? boolean(body.stream, "stream") : false;
  if (own(body, "stream_options")) {
    if (!stream) fail("stream_options", "stream_options requires stream:true");
    fields(body.stream_options, ["include_usage"], "stream_options");
    if (own(body.stream_options, "include_usage")) boolean(body.stream_options.include_usage, "stream_options.include_usage");
  }
  const request = { model: route.deployment, input: [], stream };
  const instructionRoles = new Set();
  const ids = new Set();
  const pending = new Set();
  for (const [index, originalMessage] of body.messages.entries()) {
    const path = `messages[${index}]`;
    if (!object(originalMessage)) fail(path, "Messages must be objects");
    if (originalMessage.role === "function") unsupported(`${path}.role`, "Legacy Chat function messages are standard but call-ID conversion is not implemented");
    const role = choice(originalMessage.role, ["system", "developer", "user", "assistant", "tool"], `${path}.role`);
    let message = originalMessage;
    if (role === "assistant") {
      message = { ...originalMessage };
      if (message.audio === null) delete message.audio;
      if (message.function_call === null) delete message.function_call;
      if (Array.isArray(message.tool_calls) && message.tool_calls.length === 0) delete message.tool_calls;
    }
    const messageFields = role === "tool" ? ["role", "content", "tool_call_id"] : role === "assistant" ? ["role", "content", "tool_calls", "refusal", "reasoning_content", "phase", "annotations"] : ["role", "content"];
    if (own(message, "annotations")) validateClientMetadata(message.annotations, `${path}.annotations`);
    const clientFields = Array.isArray(config.clientMetadataFields) ? config.clientMetadataFields : WORKBUDDY_MESSAGE_FIELDS;
    const autoMetadata = config.clientMetadataMode === "auto";
    for (const key of Object.keys(message)) {
      if (messageFields.includes(key) || clientFields.includes(key)) continue;
      // Reserved names carry real meaning; configuration and auto mode may not absorb them.
      if (RESERVED_MESSAGE_FIELDS.includes(key)) unsupported(`${path}.${key}`, `Standard Chat message field ${path}.${key} is not implemented by this GPT-6 Responses adapter`);
      if (!autoMetadata || !isBoundedMetadataKey(key)) throw new BridgeError(`Unknown request field: ${path}.${key}`, { param: `${path}.${key}`, code: "unknown_parameter" });
      validateClientMetadata(message[key], `${path}.${key}`);
    }
    // Explicit, bounded WorkBuddy client metadata only. These cannot change
    // authority, truncate/reorder history, select a deployment, become provider
    // metadata, or establish conversation/branch identity.
    if (own(message, "startsNewUserRequest") && clientFields.includes("startsNewUserRequest")) boolean(message.startsNewUserRequest, `${path}.startsNewUserRequest`);
    for (const field of clientFields) {
      if (field === "startsNewUserRequest" || !own(message, field)) continue;
      validateClientMetadata(message[field], `${path}.${field}`);
    }
    if (role === "tool") {
      const id = callId(message.tool_call_id, `${path}.tool_call_id`);
      if (!pending.has(id)) fail(`${path}.tool_call_id`, "Tool output must match an unresolved earlier function call");
      pending.delete(id);
      request.input.push({ type: "function_call_output", call_id: id, output: toolOutput(message.content, `${path}.content`) });
      continue;
    }
    if (pending.size && (role === "user" || role === "assistant")) fail(path, "All pending tool calls must be resolved before the next user/assistant turn");
    const hasCalls = own(message, "tool_calls");
    if (hasCalls && (!Array.isArray(message.tool_calls) || !message.tool_calls.length)) fail(`${path}.tool_calls`, "tool_calls must be a nonempty array");
    if (own(message, "reasoning_content") && message.reasoning_content !== null) string(message.reasoning_content, `${path}.reasoning_content`, Infinity, true);
    // Display summaries are deliberately not replayed as opaque provider reasoning.
    const assistantHasOutput = role === "assistant" && (hasCalls || typeof message.refusal === "string");
    const content = assistantHasOutput && message.content === undefined ? null : message.content;
    const parts = contentParts(content, role, profile, `${path}.content`, role === "assistant" && (hasCalls || own(message, "refusal")));
    if (own(message, "refusal") && message.refusal !== null) parts.push({ type: "refusal", refusal: string(message.refusal, `${path}.refusal`, Infinity, true) });
    let translatedRole = role;
    if (role === "system" || role === "developer") {
      instructionRoles.add(role);
      if (policy === "system" || policy === "developer") translatedRole = policy;
      if (policy === "reject-mixed" && instructionRoles.size > 1) fail(`${path}.role`, "Mixed system/developer instructions are disabled by policy");
    }
    if (own(message, "phase")) {
      choice(message.phase, ["commentary", "final_answer"], `${path}.phase`);
      if (!parts.length) fail(`${path}.phase`, "phase requires a representable assistant message content item");
    }
    if (parts.length) {
      const item = { role: translatedRole, content: parts };
      if (own(message, "phase")) item.phase = message.phase;
      request.input.push(item);
    } else if (!hasCalls) fail(`${path}.content`, "Assistant message must contain content, a refusal, or function calls");
    if (hasCalls) {
      for (const [callIndex, call] of message.tool_calls.entries()) {
        const callPath = `${path}.tool_calls[${callIndex}]`;
        fields(call, ["id", "type", "function"], callPath);
        choice(call.type, ["function"], `${callPath}.type`);
        fields(call.function, ["name", "arguments"], `${callPath}.function`);
        const id = callId(call.id, `${callPath}.id`);
        if (ids.has(id)) fail(`${callPath}.id`, "Function call IDs must be unique within a history");
        ids.add(id); pending.add(id);
        request.input.push({ type: "function_call", call_id: id, name: functionName(call.function.name, `${callPath}.function.name`), arguments: argumentsString(call.function.arguments, `${callPath}.function.arguments`) });
      }
    }
  }
  if (pending.size) fail("messages", "History ends with unresolved function calls; provide their tool outputs");

  const toolNames = new Set();
  if (own(body, "tools")) {
    if (!Array.isArray(body.tools)) fail("tools", "tools must be an array");
    request.tools = body.tools.map((tool, index) => {
      const path = `tools[${index}]`;
      fields(tool, tool?.type === "custom" ? ["type", "custom"] : ["type", "function"], path);
      if (tool.type === "custom") unsupported(`${path}.type`, "Chat custom tools are standard but this bridge implements function tools only");
      choice(tool.type, ["function"], `${path}.type`);
      fields(tool.function, ["name", "description", "parameters", "strict"], `${path}.function`);
      const name = functionName(tool.function.name, `${path}.function.name`);
      if (toolNames.has(name)) fail(`${path}.function.name`, "Tool names must be unique");
      toolNames.add(name);
      const strict = own(tool.function, "strict") && tool.function.strict !== null ? boolean(tool.function.strict, `${path}.function.strict`) : false;
      const parameters = own(tool.function, "parameters") ? schemaObject(tool.function.parameters, `${path}.function.parameters`, strict) : { type: "object", properties: {}, ...(strict ? { required: [], additionalProperties: false } : {}) };
      return { type: "function", name, parameters, strict, ...(own(tool.function, "description") ? { description: string(tool.function.description, `${path}.function.description`, Infinity, true) } : {}) };
    });
  }
  if (own(body, "tool_choice")) {
    if (typeof body.tool_choice === "string") {
      request.tool_choice = choice(body.tool_choice, ["auto", "none", "required"], "tool_choice");
      if (!toolNames.size && body.tool_choice === "required") fail("tool_choice", "tool_choice:required requires available function tools");
      if (!toolNames.size && body.tool_choice === "auto") request.tool_choice = "none";
    } else {
      if (object(body.tool_choice) && ["custom", "allowed_tools"].includes(body.tool_choice.type)) unsupported("tool_choice", "This standard Chat tool-choice variant is not implemented by the function-only bridge");
      fields(body.tool_choice, ["type", "function"], "tool_choice");
      choice(body.tool_choice.type, ["function"], "tool_choice.type");
      fields(body.tool_choice.function, ["name"], "tool_choice.function");
      const name = functionName(body.tool_choice.function.name, "tool_choice.function.name");
      if (!toolNames.has(name)) fail("tool_choice.function.name", "Chosen function must be declared in tools");
      request.tool_choice = { type: "function", name };
    }
  }
  if (own(body, "parallel_tool_calls")) {
    const parallel = boolean(body.parallel_tool_calls, "parallel_tool_calls");
    if (toolNames.size) request.parallel_tool_calls = parallel;
    // With no declared tools this is an applicability no-op, not an error.
  }

  const effort = own(body, "reasoning_effort") ? body.reasoning_effort : defaults.reasoningEffort ?? profile.defaultEffort;
  const mode = own(body, "reasoning_mode") ? body.reasoning_mode : defaults.reasoningMode;
  const context = own(body, "reasoning_context") ? body.reasoning_context : defaults.reasoningContext;
  const reasoning = {};
  if (effort !== undefined) {
    choice(effort, ["none", "minimal", "low", "medium", "high", "xhigh", "max"], "reasoning_effort");
    if (!Array.isArray(profile.efforts) || !profile.efforts.includes(effort)) unsupported("reasoning_effort", "This standard reasoning effort is not supported by the configured deployment profile");
    reasoning.effort = effort;
  }
  if (mode !== undefined) reasoning.mode = choice(mode, profile.reasoningModes, "reasoning_mode");
  if (context !== undefined) reasoning.context = choice(context, profile.reasoningContexts, "reasoning_context");
  if (Object.keys(reasoning).length) {
    if (effort !== "none") reasoning.summary = "auto";
    request.reasoning = reasoning;
  }
  for (const [key, max] of [["temperature", 2], ["top_p", 1]]) {
    if (!own(body, key)) continue;
    if (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > max) fail(key, `${key} is out of range`);
    if (effort === undefined || !Array.isArray(profile.samplingEfforts) || !profile.samplingEfforts.includes(effort)) {
      if (config.samplingPolicy === "drop-defaults" && body[key] === 1) continue;
      fail(key, `${key} is not supported at the effective reasoning effort`);
    }
    request[key] = body[key];
  }
  const configCap = positiveInteger(config.maxOutputTokens, "config.maxOutputTokens");
  const profileCap = positiveInteger(profile.maxOutputTokens, "profile.maxOutputTokens");
  const cap = Math.min(configCap, profileCap);
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (!own(body, key)) continue;
    positiveInteger(body[key], key);
    if (body[key] > cap) fail(key, "Requested output budget exceeds the configured deployment cap");
  }
  const requestedCap = body.max_completion_tokens ?? body.max_tokens ?? Math.min(config.defaultMaxOutputTokens ?? cap, cap);
  request.max_output_tokens = requestedCap;

  const text = {};
  if (own(body, "response_format")) {
    const format = body.response_format;
    if (!object(format)) fail("response_format", "response_format must be an object");
    if (format.type === "text" || format.type === "json_object") {
      fields(format, ["type"], "response_format");
      text.format = { type: format.type };
    } else if (format.type === "json_schema") {
      fields(format, ["type", "json_schema"], "response_format");
      fields(format.json_schema, ["name", "description", "schema", "strict"], "response_format.json_schema");
      const source = format.json_schema;
      const strict = own(source, "strict") && source.strict !== null ? boolean(source.strict, "response_format.json_schema.strict") : false;
      text.format = { type: "json_schema", name: functionName(source.name, "response_format.json_schema.name"), schema: schemaObject(source.schema, "response_format.json_schema.schema", strict), strict, ...(own(source, "description") ? { description: string(source.description, "response_format.json_schema.description", Infinity, true) } : {}) };
    } else fail("response_format.type", "Unsupported response_format");
  }
  if (own(body, "verbosity")) {
    if (profile.verbosity !== true) fail("verbosity", "Verbosity is not enabled for this deployment");
    text.verbosity = choice(body.verbosity, ["low", "medium", "high"], "verbosity");
  }
  if (Object.keys(text).length) request.text = text;
  const key = own(body, "prompt_cache_key") ? body.prompt_cache_key : defaults.cacheKey;
  const options = own(body, "prompt_cache_options") ? body.prompt_cache_options : defaults.cacheOptions;
  if (key !== undefined && key !== null) {
    if (typeof key !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(key)) fail("prompt_cache_key", "Use a non-secret prefix-family identifier (1-128 ASCII characters)");
    request.prompt_cache_key = key;
  }
  if (options !== undefined) {
    request.prompt_cache_options = cacheOptions(options, "prompt_cache_options");
    if (request.prompt_cache_options.mode === "explicit" && profile.deploymentType === "ptu-m") fail("prompt_cache_options.mode", "Explicit cache policy is not supported on PTU-M deployments");
  }
  const store = own(body, "store") ? boolean(body.store, "store") : defaults.store ?? false;
  boolean(store, "store");
  if (store && config.allowStore !== true) fail("store", "Provider storage requires explicit bridge opt-in");
  request.store = store;
  if (own(body, "metadata")) {
    if (!object(body.metadata) || Object.keys(body.metadata).length > 16) fail("metadata", "metadata must be an object with at most 16 entries");
    for (const [name, value] of Object.entries(body.metadata)) {
      string(name, "metadata key", 64);
      string(value, `metadata.${name}`, 512, true);
    }
    request.metadata = jsonClone(body.metadata, "metadata");
  }
  if (own(body, "user")) request.user = string(body.user, "user", 512);
  if (own(body, "safety_identifier")) request.safety_identifier = string(body.safety_identifier, "safety_identifier", 128);
  return request;
}

function mapUsage(usage) {
  if (usage === undefined || usage === null) return undefined;
  if (!object(usage)) upstreamFail("Azure usage must be an object");
  const result = {};
  const count = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0) upstreamFail(`Invalid Azure usage counter: ${name}`);
    return value;
  };
  for (const [source, target] of [["input_tokens", "prompt_tokens"], ["output_tokens", "completion_tokens"], ["total_tokens", "total_tokens"]]) {
    if (own(usage, source)) result[target] = count(usage[source], source);
  }
  for (const [source, target] of [["input_tokens_details", "prompt_tokens_details"], ["output_tokens_details", "completion_tokens_details"]]) {
    if (!own(usage, source) || usage[source] === null) continue;
    if (!object(usage[source])) upstreamFail(`Invalid Azure usage details: ${source}`);
    const details = {};
    for (const [name, value] of Object.entries(usage[source])) {
      Object.defineProperty(details, name, { value: value === null ? null : count(value, `${source}.${name}`), enumerable: true, writable: true, configurable: true });
    }
    result[target] = details;
  }
  const rawCounters = (node, depth = 0) => {
    if (depth > 8) upstreamFail("Azure usage exceeds the supported nesting depth");
    if (node === null) return null;
    if (typeof node === "number") return count(node, "raw counter");
    if (!object(node) || Object.keys(node).length > 100) upstreamFail("Azure usage must contain bounded numeric counters, not opaque data");
    const copied = {};
    for (const [name, value] of Object.entries(node)) Object.defineProperty(copied, name, { value: rawCounters(value, depth + 1), enumerable: true, writable: true, configurable: true });
    return copied;
  };
  result.azure_usage = rawCounters(usage);
  return result;
}
function validCalls(response) {
  const output = Array.isArray(response.output) ? response.output : [];
  const calls = output.filter((item) => object(item) && item.type === "function_call");
  const frequencies = new Map();
  for (const item of calls) frequencies.set(item.call_id, (frequencies.get(item.call_id) || 0) + 1);
  const result = [];
  for (const item of calls) {
    if (item.status !== undefined && item.status !== "completed") continue;
    if (frequencies.get(item.call_id) !== 1) continue;
    try {
      const id = callId(item.call_id, "call_id");
      const name = functionName(item.name, "name");
      const args = argumentsString(item.arguments, "arguments");
      result.push({ id, type: "function", function: { name, arguments: args } });
    } catch { /* Do not advertise malformed calls as executable. */ }
  }
  return result;
}
function terminalOutcome(response) {
  const status = object(response) && typeof response.status === "string" ? response.status : "invalid";
  let finishReason = null;
  let error;
  let allowToolCalls = false;
  const successfulStatus = status === "completed" || (status === "incomplete" && ["max_output_tokens", "content_filter"].includes(response.incomplete_details?.reason));
  const output = object(response) && Array.isArray(response.output) ? response.output : [];
  const material = output.filter((item) => object(item) && ["message", "function_call"].includes(item.type));
  const calls = material.filter((item) => item.type === "function_call");
  const safeCalls = status === "completed" ? validCalls(response) : [];
  const unknownItemStatus = material.some((item) => own(item, "status") && !["completed", "in_progress", "incomplete"].includes(item.status));
  const unfinishedItems = material.filter((item) => item.status === "in_progress" || item.status === "incomplete");
  const filteredItem = unfinishedItems.some((item) => item.incomplete_details?.reason === "content_filter") || (unfinishedItems.length > 0 && response.incomplete_details?.reason === "content_filter");
  let suppressedToolCalls = calls.length - safeCalls.length;
  if (successfulStatus && !Array.isArray(response.output)) {
    error = { message: "Azure terminal output must be an array", type: "upstream_error", code: "invalid_upstream_response", param: null };
  } else if (successfulStatus && unknownItemStatus) {
    error = { message: "Azure material output has an unknown item status", type: "upstream_error", code: "invalid_upstream_response", param: null };
  } else if (status === "completed" && filteredItem) {
    finishReason = "content_filter";
    suppressedToolCalls = calls.length;
  } else if (status === "completed" && calls.length && !safeCalls.length) {
    error = { message: "Azure completed response contains no valid executable function calls", type: "upstream_error", code: "invalid_upstream_response", param: null };
  } else if (status === "completed") {
    allowToolCalls = true;
    finishReason = unfinishedItems.length ? "length" : safeCalls.length ? "tool_calls" : "stop";
  } else if (status === "incomplete" && response.incomplete_details?.reason === "max_output_tokens") finishReason = "length";
  else if (status === "incomplete" && response.incomplete_details?.reason === "content_filter") finishReason = "content_filter";
  else {
    const source = object(response?.error) ? response.error : {};
    error = {
      message: typeof source.message === "string" ? source.message : `Azure response has no successful terminal outcome (${status})`,
      type: typeof source.type === "string" ? source.type : "upstream_error",
      code: typeof source.code === "string" || typeof source.code === "number" ? source.code : status === "invalid" ? "invalid_upstream_response" : `response_${status}`,
      param: typeof source.param === "string" ? source.param : null,
    };
  }
  const ok = finishReason !== null;
  return { ok, successful: ok, completed: status === "completed", status, finishReason, allowToolCalls, suppressedToolCalls, ...(error ? { error } : {}) };
}
function safeAnnotations(value) {
  if (!Array.isArray(value) || value.length > 10000) upstreamFail("Azure output annotations must be a bounded array");
  return value.flatMap((annotation) => {
    if (!object(annotation) || typeof annotation.type !== "string") upstreamFail("Invalid Azure output annotation");
    if (!["url_citation", "file_citation"].includes(annotation.type)) return [];
    const result = { type: annotation.type };
    const textFields = annotation.type === "url_citation" ? ["url", "title"] : ["file_id", "filename"];
    const required = annotation.type === "url_citation" ? "url" : "file_id";
    if (typeof annotation[required] !== "string" || !annotation[required]) upstreamFail("Azure citation is missing its identity");
    for (const field of textFields) {
      if (!own(annotation, field)) continue;
      const max = field === "url" ? 8192 : 1024;
      if (typeof annotation[field] !== "string" || annotation[field].length > max) upstreamFail("Invalid Azure citation text");
      result[field] = annotation[field];
    }
    if (annotation.type === "url_citation") {
      let url;
      try { url = new URL(result.url); } catch { upstreamFail("Invalid Azure citation URL"); }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) upstreamFail("Unsafe Azure citation URL");
    }
    for (const field of ["index", "start_index", "end_index"]) {
      if (!own(annotation, field)) continue;
      if (!Number.isSafeInteger(annotation[field]) || annotation[field] < 0) upstreamFail("Invalid Azure citation index");
      result[field] = annotation[field];
    }
    if (own(result, "start_index") && own(result, "end_index") && result.end_index < result.start_index) upstreamFail("Azure citation indices are out of order");
    return [result];
  });
}
function safeContentFilters(value) {
  const containers = new Set(["content_filter_results", "hate", "sexual", "self_harm", "violence", "jailbreak", "protected_material_text", "protected_material_code", "profanity", "custom_blocklists", "indirect_attack"]);
  const sanitize = (node, depth = 0) => {
    if (depth > 8) upstreamFail("Azure content filters exceed the supported nesting depth");
    if (Array.isArray(node)) {
      if (node.length > 100) upstreamFail("Azure content filters exceed the supported array size");
      return node.map((item) => sanitize(item, depth + 1));
    }
    if (!object(node)) upstreamFail("Azure content filters must contain objects");
    const result = {};
    for (const [key, field] of Object.entries(node)) {
      if (containers.has(key)) result[key] = sanitize(field, depth + 1);
      else if (["filtered", "detected", "blocked"].includes(key)) {
        if (typeof field !== "boolean") upstreamFail("Invalid Azure content-filter boolean");
        result[key] = field;
      } else if (key === "severity") {
        if (!["safe", "low", "medium", "high"].includes(field)) upstreamFail("Invalid Azure content-filter severity");
        result[key] = field;
      } else if (key === "source_type") {
        if (!["prompt", "completion", "output", "input"].includes(field)) upstreamFail("Invalid Azure content-filter source");
        result[key] = field;
      } else if (["prompt_index", "output_index"].includes(key)) {
        if (!Number.isSafeInteger(field) || field < 0) upstreamFail("Invalid Azure content-filter index");
        result[key] = field;
      }
      // Unknown provider fields are intentionally not copied to the client.
    }
    return result;
  };
  return sanitize(value);
}
function extractResponse(response, alias) {
  const outcome = terminalOutcome(response);
  if (!outcome.ok) throw new BridgeError(outcome.error.message, { status: 502, ...outcome.error });
  if (typeof alias !== "string" || !alias.trim()) upstreamFail("An outward model alias is required");
  if (own(response, "output") && !Array.isArray(response.output)) upstreamFail("Azure output must be an array");
  if (own(response, "id") && (typeof response.id !== "string" || !response.id.trim())) upstreamFail("Azure response ID is invalid");
  if (own(response, "created_at") && (!Number.isSafeInteger(response.created_at) || response.created_at < 0)) upstreamFail("Azure response timestamp is invalid");
  const text = [];
  const refusals = [];
  const reasoning = [];
  const annotations = [];
  for (const item of response.output || []) {
    if (!object(item) || typeof item.type !== "string") upstreamFail("Invalid Azure output item");
    if (item.type === "message") {
      if (!Array.isArray(item.content)) upstreamFail("Azure message content must be an array");
      if (item.role !== undefined && item.role !== "assistant") upstreamFail("Azure output message role must be assistant");
      for (const part of item.content) {
        if (!object(part)) upstreamFail("Invalid Azure message content block");
        if (part.type === "output_text" && typeof part.text === "string") {
          text.push(part.text);
          if (own(part, "annotations")) {
            annotations.push(...safeAnnotations(part.annotations));
          }
        } else if (part.type === "refusal" && typeof part.refusal === "string") refusals.push(part.refusal);
        else upstreamFail("Unsupported or invalid Azure message content block");
      }
    } else if (item.type === "reasoning") {
      if (own(item, "summary") && !Array.isArray(item.summary)) upstreamFail("Azure reasoning summary must be an array");
      for (const part of item.summary || []) {
        if (!object(part) || part.type !== "summary_text" || typeof part.text !== "string") upstreamFail("Invalid Azure reasoning summary");
        reasoning.push(part.text);
      }
      // encrypted_content/raw reasoning/phase state are never flattened into display text.
    } else if (item.type !== "function_call" && item.type !== "compaction") {
      upstreamFail("Unsupported Azure output item type");
    }
  }
  const calls = outcome.allowToolCalls ? validCalls(response) : [];
  const message = { role: "assistant", content: text.length ? text.join("") : refusals.length ? refusals.join("") : null };
  if (refusals.length) message.refusal = refusals.join("");
  if (reasoning.length) message.reasoning_content = reasoning.join("");
  if (calls.length) message.tool_calls = calls;
  if (annotations.length) message.annotations = annotations;
  const usage = mapUsage(response.usage);
  const result = {
    id: `chatcmpl-${response.id || "response"}`,
    object: "chat.completion",
    created: response.created_at ?? 0,
    model: alias,
    choices: [{ index: 0, message, finish_reason: outcome.finishReason }],
    ...(usage !== undefined ? { usage } : {}),
  };
  if (own(response, "content_filters")) result.azure_content_filters = response.content_filters === null ? null : safeContentFilters(response.content_filters);
  if (outcome.suppressedToolCalls) result.bridge_warnings = ["suppressed_invalid_or_incomplete_tool_calls"];
  return result;
}

// Names only (never values) of message-level fields deliberately not forwarded.
// Used for bounded operational logging; safe to call on rejected bodies.
function ignoredClientFields(body, config) {
  if (!object(body) || !Array.isArray(body.messages)) return [];
  const clientFields = Array.isArray(config?.clientMetadataFields) ? config.clientMetadataFields : WORKBUDDY_MESSAGE_FIELDS;
  const auto = config?.clientMetadataMode === "auto";
  const names = new Set();
  for (const message of body.messages.slice(0, 256)) {
    if (!object(message) || typeof message.role !== "string") continue;
    const consumed = ADAPTER_MESSAGE_FIELDS[message.role] || ADAPTER_MESSAGE_FIELDS.user;
    for (const key of Object.keys(message)) {
      if (consumed.includes(key) || RESERVED_MESSAGE_FIELDS.includes(key)) continue;
      if (clientFields.includes(key)) names.add(key);
      else if (auto && isBoundedMetadataKey(key)) names.add(key);
    }
  }
  return [...names].sort().slice(0, 32).map(name => `messages.${name}`);
}

module.exports = { BridgeError, toResponsesRequest, extractResponse, mapUsage, terminalOutcome, ignoredClientFields };
