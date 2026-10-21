"use strict";
const { CHAT_REQUEST_FIELDS, CHAT_MESSAGE_FIELDS, BRIDGE_REQUEST_FIELDS, WORKBUDDY_MESSAGE_FIELDS, isBoundedMetadataKey, sanitizeMetadataKey } = require("./chat-contract");

// Diagnostics project only fixed categories/types and safe protocol paths. Never
// retain messages, error text, arbitrary field names, identifiers or values.
const STAGES = new Set(["routing", "authentication", "capacity", "upload", "request_conversion", "upstream_headers", "upstream_body", "response_conversion", "streaming"]);
const CODES = new Set(["invalid_parameter", "unknown_parameter", "unsupported_parameter", "model_not_found", "invalid_json", "request_too_large", "unsupported_media_type"]);
const PARTS = new Set(["body", ...CHAT_REQUEST_FIELDS, ...BRIDGE_REQUEST_FIELDS,
  ...Object.values(CHAT_MESSAGE_FIELDS).flat(), ...WORKBUDDY_MESSAGE_FIELDS,
  "function", "custom", "name", "description", "parameters", "strict", "id", "arguments",
  "type", "text", "image_url", "url", "detail", "input_audio", "file", "data", "format",
  "json_schema", "schema", "include_usage", "include_obfuscation", "mode", "ttl",
  "prompt_cache_breakpoint", "reasoning_content", "phase"]);
const OPAQUE_PARTS = new Set(["parameters", "schema", "metadata", "agent", "arguments", "data"]);
function safeValidationParam(param, secrets = []) {
  if (typeof param !== "string" || param.length > 512 || secrets.some(value => typeof value === "string" && value && param.includes(value))) return "<redacted_parameter>";
  if (param === "<redacted_parameter>" || /^(?:body|messages\[\d{1,6}\]|tools\[\d{1,6}\])\.<unknown_field>$/.test(param)) return param;
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,6}\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(param)) {
    const prefix = /^(?:body\.)?(messages\[\d{1,6}\]|tools\[\d{1,6}\])/.exec(param);
    return prefix ? `${prefix[1]}.<unknown_field>` : "<redacted_parameter>";
  }
  const tokens = param.match(/[A-Za-z_][A-Za-z0-9_]*|\[\d+\]/g) || [];
  const result = [];
  for (const token of tokens.slice(0, 16)) {
    if (token.startsWith("[")) { if (result.length) result[result.length - 1] += token; continue; }
    if (!PARTS.has(token)) { result.push("<unknown_field>"); break; }
    result.push(token);
    if (OPAQUE_PARTS.has(token)) break;
  }
  return result.length ? result.join(".").slice(0, 192) : "<redacted_parameter>";
}
function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return ["string", "number", "boolean", "object", "undefined"].includes(typeof value) ? typeof value : "unavailable";
}
function valueTypeAtParam(body, param) {
  if (typeof param !== "string" || param.length > 512 || !/^[A-Za-z_][A-Za-z0-9_]*(?:\[\d{1,6}\]|\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(param)) return "unavailable";
  const keys = param.match(/[A-Za-z_][A-Za-z0-9_]*|\d+/g) || [];
  if (keys[0] === "body") keys.shift();
  let value = body;
  try {
    for (const key of keys.slice(0, 16)) {
      if (value === null || typeof value !== "object") return "unavailable";
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) return "unavailable";
      value = descriptor.value;
    }
    return jsonType(value);
  } catch { return "unavailable"; }
}
function unknownKeyAtParam(param) {
  // The final segment of an unknown-field path, when it is a bounded key. Keys
  // are protocol surface; values are never captured. Unusual characters are
  // masked so the name is still diagnosable.
  if (typeof param !== "string") return undefined;
  const match = /^messages\[\d{1,6}\]\.([\s\S]+)$/.exec(param);
  if (!match || !isBoundedMetadataKey(match[1])) return undefined;
  return sanitizeMetadataKey(match[1]);
}
function validationDiagnostics(error, stage, body, secrets = []) {
  if (error?.type !== "invalid_request_error" || !Number.isInteger(error.status) || error.status < 400 || error.status >= 500) return {};
  const key = error.code === "unknown_parameter" ? unknownKeyAtParam(error.param) : undefined;
  return {
    validationType: "invalid_request_error",
    validationCode: CODES.has(error.code) ? error.code : "invalid_parameter",
    validationParam: safeValidationParam(error.param, secrets),
    ...(key ? { validationKey: key } : {}),
    validationValueType: valueTypeAtParam(body, error.param),
    stage: STAGES.has(stage) ? stage : "request_conversion",
  };
}
module.exports = { STAGES, CODES, safeValidationParam, jsonType, valueTypeAtParam, unknownKeyAtParam, validationDiagnostics };
