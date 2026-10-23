"use strict";

// Endpoint-specific schema snapshot. Never load fixtures/configuration at runtime.
const REGISTRY_VERSION = "azure-openai-responses-enum-2026-10-22";
const groups = {
  audio: ["response.audio.delta", "response.audio.done", "response.audio.transcript.delta", "response.audio.transcript.done"],
  "code-interpreter": ["response.code_interpreter_call_code.delta", "response.code_interpreter_call_code.done", "response.code_interpreter_call.completed", "response.code_interpreter_call.in_progress", "response.code_interpreter_call.interpreting"],
  "lifecycle-terminal": ["response.completed", "response.failed", "response.incomplete"],
  "message-content-lifecycle": ["response.content_part.added", "response.content_part.done"],
  lifecycle: ["response.created", "response.in_progress"],
  error: ["error"],
  "file-search": ["response.file_search_call.completed", "response.file_search_call.in_progress", "response.file_search_call.searching"],
  "function-tool": ["response.function_call_arguments.delta", "response.function_call_arguments.done"],
  "output-item-lifecycle": ["response.output_item.added", "response.output_item.done"],
  "reasoning-summary": ["response.reasoning_summary_part.added", "response.reasoning_summary_part.done", "response.reasoning_summary_text.delta", "response.reasoning_summary_text.done"],
  "raw-reasoning": ["response.reasoning_text.delta", "response.reasoning_text.done"],
  refusal: ["response.refusal.delta", "response.refusal.done"],
  "output-text": ["response.output_text.delta", "response.output_text.done"],
  "web-search": ["response.web_search_call.completed", "response.web_search_call.in_progress", "response.web_search_call.searching"],
  "image-generation": ["response.image_generation_call.completed", "response.image_generation_call.generating", "response.image_generation_call.in_progress", "response.image_generation_call.partial_image"],
  mcp: ["response.mcp_call_arguments.delta", "response.mcp_call_arguments.done", "response.mcp_call.completed", "response.mcp_call.failed", "response.mcp_call.in_progress", "response.mcp_list_tools.completed", "response.mcp_list_tools.failed", "response.mcp_list_tools.in_progress"],
  annotation: ["response.output_text.annotation.added"],
  "lifecycle-queued": ["response.queued"],
  "custom-tool": ["response.custom_tool_call_input.delta", "response.custom_tool_call_input.done"],
};
const FEATURE_CATEGORIES = Object.freeze(["audio", "code-interpreter", "file-search", "web-search", "image-generation", "mcp", "custom-tool"]);
const statuses = Object.freeze({
  "response.created": null, "response.queued": "queued", "response.in_progress": "in_progress",
  "response.completed": "completed", "response.failed": "failed", "response.incomplete": "incomplete", "response.cancelled": "cancelled",
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === "string" && value.length > 0;
const coreItems = new Set(["message", "function_call", "reasoning", "compaction", "file_search_call", "web_search_call", "code_interpreter_call", "image_generation_call", "mcp_call", "mcp_list_tools", "mcp_approval_request", "custom_tool_call"]);

function fieldsFor(name, category) {
  const fields = { type: "string", sequence_number: "integer" };
  if (own(statuses, name)) fields.response = "object";
  else if (name === "error") { fields.code = "nullable-string"; fields.message = "string"; fields.param = "nullable-string"; }
  else {
    const indexed = !["audio", "error", "lifecycle", "lifecycle-terminal", "lifecycle-queued"].includes(category);
    if (indexed) fields.output_index = "integer";
    if (indexed && category !== "output-item-lifecycle") fields.item_id = "identity";
    if (name.endsWith(".delta")) fields.delta = "string";
    if (["output-text", "refusal", "raw-reasoning", "message-content-lifecycle", "annotation"].includes(category)) fields.content_index = "integer";
    if (category === "reasoning-summary") fields.summary_index = "integer";
    if (category === "output-item-lifecycle") fields.item = "object";
    if (category === "message-content-lifecycle" || name.startsWith("response.reasoning_summary_part.")) fields.part = "object";
    if (name === "response.output_text.annotation.added") { fields.annotation = "object"; fields.annotation_index = "integer"; }
    if (name === "response.image_generation_call.partial_image") { fields.partial_image_b64 = "string"; fields.partial_image_index = "integer"; }
    if (["response.function_call_arguments.done", "response.mcp_call_arguments.done"].includes(name)) fields.arguments = "string";
    if (name === "response.function_call_arguments.done") fields.name = "string";
    if (name === "response.custom_tool_call_input.done") fields.input = "string";
    if (name === "response.code_interpreter_call_code.done") fields.code = "string";
    if (name === "response.refusal.done") fields.refusal = "string";
    if (["response.output_text.done", "response.reasoning_summary_text.done", "response.reasoning_text.done"].includes(name)) fields.text = "string";
    // Audio/transcript done events have no required text field in the Azure enum schema.
  }
  return Object.freeze(fields);
}
const registry = Object.create(null);
for (const [category, names] of Object.entries(groups)) for (const name of names) {
  registry[name] = Object.freeze({ name, category, featureGated: FEATURE_CATEGORIES.includes(category), fields: fieldsFor(name, category) });
}
const EVENT_REGISTRY = Object.freeze(registry);
const COMPATIBILITY_EVENTS = Object.freeze(Object.assign(Object.create(null), {
  "response.cancelled": Object.freeze({ name: "response.cancelled", category: "bridge-compatibility-only", inDocumentedEnum: false, fields: Object.freeze({ type: "string", response: "object" }) }),
}));
function invalid() {
  return Object.assign(new Error("Native event shape is invalid"), { code: "invalid_native_shape", status: 502, type: "upstream_error" });
}
function matches(value, kind) {
  if (kind === "integer") return integer(value);
  if (kind === "identity") return identity(value);
  if (kind === "object") return object(value);
  if (kind === "nullable-string") return value === null || typeof value === "string";
  return typeof value === "string";
}
function validateNativeEvent(name, payload) {
  if (typeof name !== "string" || !/^[A-Za-z0-9_.-]{1,128}$/.test(name) || !object(payload) || payload.type !== name) throw invalid();
  const entry = EVENT_REGISTRY[name] || COMPATIBILITY_EVENTS[name];
  if (!entry) return { known: false, terminal: false, category: "unknown" };
  const nestedError = name === "error" && own(payload, "error");
  if (nestedError) {
    // Azure's how-to documents this variant without an outer sequence number.
    if (!object(payload.error) || typeof payload.error.message !== "string") throw invalid();
    if (own(payload.error, "code") && !matches(payload.error.code, "nullable-string")) throw invalid();
    if (own(payload.error, "type") && typeof payload.error.type !== "string") throw invalid();
    if (own(payload.error, "param") && !matches(payload.error.param, "nullable-string")) throw invalid();
  } else for (const [field, kind] of Object.entries(entry.fields)) if (!own(payload, field) || !matches(payload[field], kind)) throw invalid();
  if (own(payload, "sequence_number") && !integer(payload.sequence_number)) throw invalid();
  if (own(statuses, name)) {
    const response = payload.response;
    if (!identity(response.id)) throw invalid();
    if (name === "response.created") {
      if (own(response, "status") && !["in_progress", "queued"].includes(response.status)) throw invalid();
    } else if (response.status !== statuses[name]) throw invalid();
    if (own(response, "output") && !Array.isArray(response.output)) throw invalid();
    if (own(response, "error") && response.error !== null && !object(response.error)) throw invalid();
    if (own(response, "incomplete_details") && response.incomplete_details !== null && !object(response.incomplete_details)) throw invalid();
  }
  if (entry.category === "output-item-lifecycle") {
    const item = payload.item;
    if (!identity(item.type)) throw invalid();
    if (coreItems.has(item.type) && !identity(item.id)) throw invalid();
    if (own(item, "id") && item.id !== null && !identity(item.id)) throw invalid();
  }
  if (own(entry.fields, "part")) {
    if (!identity(payload.part.type)) throw invalid();
    if (name.startsWith("response.reasoning_summary_part.") && (payload.part.type !== "summary_text" || typeof payload.part.text !== "string")) throw invalid();
  }
  if (name === "response.output_text.annotation.added" && !identity(payload.annotation.type)) throw invalid();
  // Some provider versions omit empty logprobs. Preserve them unchanged when present.
  if (entry.category === "output-text" && own(payload, "logprobs") && !Array.isArray(payload.logprobs)) throw invalid();
  const terminal = ["response.completed", "response.failed", "response.incomplete", "response.cancelled", "error"].includes(name);
  return { known: true, terminal, category: entry.category };
}
module.exports = { REGISTRY_VERSION, EVENT_REGISTRY, COMPATIBILITY_EVENTS, FEATURE_CATEGORIES, validateNativeEvent };
