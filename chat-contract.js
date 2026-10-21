"use strict";

// A field-recognition snapshot, not a claim that every Chat feature is available
// on every GPT-6 Azure Responses deployment. No I/O or environment reads.
// Source: OpenAI's generated openai-node Chat Completions types, reviewed 2026-10-21.
const CHAT_REQUEST_FIELDS = Object.freeze([
  "messages", "model", "audio", "frequency_penalty", "function_call", "functions",
  "logit_bias", "logprobs", "max_completion_tokens", "max_tokens", "metadata",
  "modalities", "moderation", "n", "parallel_tool_calls", "prediction", "presence_penalty",
  "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention", "reasoning_effort",
  "response_format", "safety_identifier", "seed", "service_tier", "stop", "store", "stream",
  "stream_options", "temperature", "tool_choice", "tools", "top_logprobs", "top_p", "user",
  "verbosity", "web_search_options",
]);
const CHAT_MESSAGE_FIELDS = Object.freeze({
  system: Object.freeze(["role", "content", "name"]),
  developer: Object.freeze(["role", "content", "name"]),
  user: Object.freeze(["role", "content", "name"]),
  assistant: Object.freeze(["role", "content", "name", "audio", "function_call", "refusal", "tool_calls"]),
  tool: Object.freeze(["role", "content", "tool_call_id"]),
  function: Object.freeze(["role", "content", "name"]),
});
const CHAT_STREAM_OPTION_FIELDS = Object.freeze(["include_usage", "include_obfuscation"]);
const CHAT_CONTENT_TYPES = Object.freeze(["text", "image_url", "input_audio", "file", "refusal"]);
const BRIDGE_REQUEST_FIELDS = Object.freeze(["reasoning_mode", "reasoning_context"]);
// Explicit, bounded WorkBuddy client-metadata extensions. Verified from observed
// WorkBuddy 5.8.3 rejections; none carries request semantics, authority or identity.
const WORKBUDDY_MESSAGE_FIELDS = Object.freeze(["startsNewUserRequest", "agent", "conversationRequestId"]);
// Fields a client-metadata extension list may never claim, because the bridge
// assigns them real meaning. Guards against widening validation by configuration.
const RESERVED_MESSAGE_FIELDS = Object.freeze([...new Set([
  ...Object.values(CHAT_MESSAGE_FIELDS).flat(),
  "reasoning_content", "phase",
])].sort());
const CLIENT_METADATA_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// Absorbed client keys may use any characters (observed: namespaced, dotted and
// non-identifier keys). Only length is bounded; reserved names are never absorbed.
const CLIENT_METADATA_KEY_MAX = 128;
function isBoundedMetadataKey(key) {
  return typeof key === "string" && key.length >= 1 && key.length <= CLIENT_METADATA_KEY_MAX;
}
// Keys are protocol surface, so they are reported; control/non-ASCII characters
// and any over-length tail are masked rather than dropped, keeping logs readable.
function sanitizeMetadataKey(key) {
  if (typeof key !== "string" || !key.length) return undefined;
  return key.slice(0, CLIENT_METADATA_KEY_MAX).replace(/[^\x20-\x7e]/g, "?");
}
const SAFE_METADATA_KEY = /^[\x20-\x7e]{1,128}$/;
const CLIENT_METADATA_MODES = Object.freeze(["strict", "auto"]);
// Per-role fields the adapter itself consumes. Anything else on a message is
// client metadata or an unimplemented standard field.
const ADAPTER_MESSAGE_FIELDS = Object.freeze({
  system: Object.freeze(["role", "content"]),
  developer: Object.freeze(["role", "content"]),
  user: Object.freeze(["role", "content"]),
  assistant: Object.freeze(["role", "content", "tool_calls", "refusal", "reasoning_content", "phase"]),
  tool: Object.freeze(["role", "content", "tool_call_id"]),
});
function validateClientMetadataFieldName(name) {
  if (typeof name !== "string" || !CLIENT_METADATA_NAME.test(name)) return "must be a 1-64 character identifier without dots or brackets";
  if (RESERVED_MESSAGE_FIELDS.includes(name)) return "would collide with a reserved message field";
  return null;
}
const NULL_AS_UNSPECIFIED = Object.freeze([
  "audio", "frequency_penalty", "logit_bias", "logprobs", "max_completion_tokens", "max_tokens",
  "metadata", "modalities", "moderation", "n", "prediction", "presence_penalty",
  "prompt_cache_retention", "reasoning_effort", "safety_identifier", "seed", "service_tier",
  "stop", "store", "stream", "stream_options", "temperature", "top_logprobs", "top_p",
  "verbosity",
]);

function isStandardField(scope, value, key) {
  if (scope === "body") return CHAT_REQUEST_FIELDS.includes(key);
  if (/^messages\[\d+\]$/.test(scope)) return CHAT_MESSAGE_FIELDS[value?.role]?.includes(key) === true;
  if (scope === "stream_options") return CHAT_STREAM_OPTION_FIELDS.includes(key);
  return false;
}
function normalizeChatDefaults(body) {
  const normalized = { ...body }, fields = [];
  const omit = key => { delete normalized[key]; fields.push(key); };
  for (const key of NULL_AS_UNSPECIFIED) if (Object.hasOwn(normalized, key) && normalized[key] === null) omit(key);
  // Exact documented disabled/default values only. Nonzero/enabled controls are
  // retained for capability rejection, never silently discarded.
  for (const key of ["frequency_penalty", "presence_penalty"]) if (normalized[key] === 0) omit(key);
  if (normalized.logprobs === false && !Object.hasOwn(normalized, "top_logprobs")) omit("logprobs");
  if (normalized.logit_bias && typeof normalized.logit_bias === "object" && !Array.isArray(normalized.logit_bias) && Object.keys(normalized.logit_bias).length === 0) omit("logit_bias");
  if (Array.isArray(normalized.modalities) && normalized.modalities.length === 1 && normalized.modalities[0] === "text") omit("modalities");
  if (Array.isArray(normalized.stop) && normalized.stop.length === 0) omit("stop");
  if (normalized.stream_options && typeof normalized.stream_options === "object" && !Array.isArray(normalized.stream_options) && Object.hasOwn(normalized.stream_options, "include_obfuscation") && normalized.stream_options.include_obfuscation === false) {
    normalized.stream_options = { ...normalized.stream_options }; delete normalized.stream_options.include_obfuscation;
    fields.push("stream_options.include_obfuscation");
  }
  // prompt_cache_key:null is deliberately retained: it requests omission of the
  // key, overriding any configured bridge key rather than reintroducing one.
  return { body: normalized, normalizedFields: fields };
}
module.exports = { CHAT_REQUEST_FIELDS, CHAT_MESSAGE_FIELDS, CHAT_STREAM_OPTION_FIELDS,
  CHAT_CONTENT_TYPES, BRIDGE_REQUEST_FIELDS, WORKBUDDY_MESSAGE_FIELDS, RESERVED_MESSAGE_FIELDS,
  ADAPTER_MESSAGE_FIELDS, CLIENT_METADATA_MODES, CLIENT_METADATA_NAME, CLIENT_METADATA_KEY_MAX,
  SAFE_METADATA_KEY, isBoundedMetadataKey, sanitizeMetadataKey,
  NULL_AS_UNSPECIFIED, isStandardField, normalizeChatDefaults, validateClientMetadataFieldName };
