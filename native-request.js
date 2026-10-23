"use strict";

const { EVENT_REGISTRY, COMPATIBILITY_EVENTS } = require("./native-events");
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const maxItems = 4096;
const maxListed = 256;
const topFields = new Set(["model", "input", "instructions", "stream", "max_output_tokens", "reasoning", "tools", "tool_choice", "parallel_tool_calls", "text", "store", "background", "prompt_cache_key", "prompt_cache_options", "prompt_cache_retention", "temperature", "top_p", "include", "top_logprobs", "metadata", "safety_identifier", "user", "max_tool_calls", "service_tier", "truncation"]);
const deferredFields = new Set(["previous_response_id", "conversation", "agent_reference", "agent_session_id", "context_management", "prompt", "stream_options", "routing_config", "user_security_context", "structured_inputs", "moderation"]);
const identifier = value => typeof value === "string" && /^[^\s\u0000-\u001f\u007f]{1,512}$/.test(value);
const functionName = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
const terminalStatuses = new Set(["completed", "failed", "incomplete", "cancelled"]);
const IMAGE_FIELDS = ["type", "model", "quality", "size", "output_format", "background", "moderation", "partial_images"];
const HOSTED_TYPES = new Set(["web_search_call", "file_search_call", "code_interpreter_call", "image_generation_call", "mcp_call", "mcp_list_tools", "mcp_approval_request"]);
const MCP_TYPES = new Set(["mcp_call", "mcp_list_tools", "mcp_approval_request"]);
const FEATURE_ITEM_TYPE = Object.freeze({
  "web-search": ["web_search_call"], "file-search": ["file_search_call"], "code-interpreter": ["code_interpreter_call"],
  "image-generation": ["image_generation_call"], mcp: ["mcp_call", "mcp_list_tools", "mcp_approval_request"], "custom-tool": ["custom_tool_call"],
});
const INLINE_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const CACHE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
// Include values the bridge understands; a tool-scoped value is valid only when that tool is declared.
const INCLUDE_VALUES = Object.freeze({
  "reasoning.encrypted_content": null,
  "message.output_text.logprobs": null,
  "file_search_call.results": "file-search",
  "code_interpreter_call.outputs": "code-interpreter",
  "image_generation_call.result": "image-generation",
  "web_search_call.action.sources": "web-search",
});
const EMPTY_PROFILE = Object.freeze({
  features: Object.freeze([]), allowStore: false, vectorStoreIds: Object.freeze([]), fileIds: Object.freeze([]),
  containerIds: Object.freeze([]), customToolNames: Object.freeze([]), mediaUrls: Object.freeze([]),
  imageModels: Object.freeze([]), mcpServers: Object.freeze([]), verifiedCapabilities: Object.freeze([]),
});
function fail(param, code = "invalid_parameter", message = "Unsupported or invalid native request parameter") { throw Object.assign(new Error(message), { code, status: 400, type: "invalid_request_error", param }); }
function fields(value, allowed, param) {
  if (!object(value)) fail(param);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(param ? `${param}.${key}` : key, "unsupported_parameter");
}
function choice(value, allowed, param) { if (!allowed.includes(value)) fail(param); }
function jsonCopy(value, param) {
  const seen = new Set(); let nodes = 0;
  const copy = (node, depth) => {
    if (++nodes > 100000 || depth > 64) fail(param);
    if (node === null || typeof node === "string" || typeof node === "boolean") return node;
    if (typeof node === "number" && Number.isFinite(node)) return node;
    if ((!object(node) && !Array.isArray(node)) || seen.has(node)) fail(param);
    if (!Array.isArray(node) && ![Object.prototype, null].includes(Object.getPrototypeOf(node))) fail(param);
    if (Array.isArray(node) && node.length > 100000 - nodes) fail(param);
    seen.add(node); const out = Array.isArray(node) ? [] : {};
    const keys = Array.isArray(node) ? Array.from({ length: node.length }, (_, i) => String(i)) : Object.keys(node);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(node, key);
      if (!descriptor || !own(descriptor, "value")) fail(param);
      Object.defineProperty(out, key, { value: copy(descriptor.value, depth + 1), enumerable: true, configurable: true, writable: true });
    }
    seen.delete(node); return out;
  };
  return copy(value, 0);
}
function schema(value, strict, param) {
  if (!object(value) || value.type !== "object") fail(param, "unsupported_parameter");
  const walk = (node, depth = 0) => {
    if (depth > 64) fail(param);
    if (typeof node === "boolean") { if (strict) fail(param, "unsupported_parameter"); return; }
    if (!object(node)) fail(param);
    if (own(node, "type")) {
      const types = Array.isArray(node.type) ? node.type : [node.type];
      if (!types.length || new Set(types).size !== types.length || types.some(t => !["object", "array", "string", "number", "integer", "boolean", "null"].includes(t))) fail(param);
    }
    if (own(node, "required") && (!Array.isArray(node.required) || new Set(node.required).size !== node.required.length || node.required.some(k => typeof k !== "string"))) fail(param);
    if (own(node, "$ref") && (typeof node.$ref !== "string" || !node.$ref.startsWith("#"))) fail(param, "unsupported_parameter");
    for (const key of ["$id", "$schema", "title", "description", "pattern", "format"]) if (own(node, key) && typeof node[key] !== "string") fail(param);
    if (own(node, "enum") && (!Array.isArray(node.enum) || !node.enum.length)) fail(param);
    for (const key of ["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]) {
      if (!own(node, key)) continue; if (!object(node[key])) fail(param);
      for (const child of Object.values(node[key])) walk(child, depth + 1);
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (strict && (types.includes("object") || own(node, "properties"))) {
      const names = Object.keys(node.properties || {});
      if (node.additionalProperties !== false || !Array.isArray(node.required) || node.required.length !== names.length || names.some(n => !node.required.includes(n))) fail(param, "unsupported_parameter");
    }
    for (const key of ["items", "contains", "not", "if", "then", "else", "additionalProperties", "propertyNames", "unevaluatedProperties", "unevaluatedItems"]) {
      if (!own(node, key)) continue;
      if (typeof node[key] === "boolean") continue;
      if (key === "items" && Array.isArray(node[key])) for (const child of node[key]) walk(child, depth + 1);
      else walk(node[key], depth + 1);
    }
    for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) {
      if (!own(node, key)) continue; if (!Array.isArray(node[key]) || !node[key].length) fail(param);
      for (const child of node[key]) walk(child, depth + 1);
    }
  };
  walk(value); return value;
}
function inlineImage(value) { return typeof value === "string" && value.length <= 2 * 1024 * 1024 + 64 && INLINE_IMAGE.test(value); }
function approvedMedia(value, profile) { return typeof value === "string" && (profile.mediaUrls.includes(value) || inlineImage(value)); }
function approvedResources(value, allowed, param, max = 16) {
  if (!Array.isArray(value) || value.length < 1 || value.length > max || new Set(value).size !== value.length || value.some(item => typeof item !== "string" || !allowed.includes(item))) fail(param, "unsupported_parameter");
  return value;
}
function shortString(value, param, max = 128) {
  if (typeof value !== "string" || value.length > max) fail(param);
  return value;
}
function content(value, role, param, profile, route) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || value.length > maxItems) fail(param);
  return value.map((part, index) => {
    const path = `${param}[${index}]`;
    if (!object(part)) fail(path);
    if (part.type === "input_image") {
      if (role === "assistant" || !profile.features.includes("image-input")) fail(path, "unsupported_parameter");
      fields(part, ["type", "image_url", "file_id", "detail"], path);
      if (own(part, "image_url") === own(part, "file_id")) fail(path);
      if (own(part, "image_url") && !approvedMedia(part.image_url, profile)) fail(path, "unsupported_parameter");
      if (own(part, "file_id") && !profile.fileIds.includes(part.file_id)) fail(path, "unsupported_parameter");
      if (own(part, "detail")) choice(part.detail, ["auto", "low", "high"], `${path}.detail`);
      return part;
    }
    if (part.type === "input_file") {
      if (role === "assistant" || !profile.features.includes("file-input")) fail(path, "unsupported_parameter");
      fields(part, ["type", "file_id", "file_url", "filename", "file_data"], path);
      if (["file_id", "file_url", "file_data"].filter(key => own(part, key)).length !== 1) fail(path);
      if (own(part, "file_id") && !profile.fileIds.includes(part.file_id)) fail(path, "unsupported_parameter");
      if (own(part, "file_url") && !profile.mediaUrls.includes(part.file_url)) fail(path, "unsupported_parameter");
      if (own(part, "file_data") && !(typeof part.file_data === "string" && part.file_data.length <= 2 * 1024 * 1024 && /^data:[^;,]{1,128};base64,[A-Za-z0-9+/=]+$/.test(part.file_data))) fail(path);
      if (own(part, "filename") && (typeof part.filename !== "string" || part.filename.length > 255 || /[\\/\0]/.test(part.filename))) fail(path);
      return part;
    }
    if (!["input_text", "output_text", "refusal"].includes(part.type) || role !== "assistant" && part.type !== "input_text") fail(path, "unsupported_parameter");
    const keys = part.type === "refusal" ? ["type", "refusal"] : part.type === "output_text" ? ["type", "text", "annotations", "logprobs"] : ["type", "text", "prompt_cache_breakpoint"];
    fields(part, keys, path);
    if (typeof part[part.type === "refusal" ? "refusal" : "text"] !== "string") fail(path);
    if (own(part, "annotations") && (!Array.isArray(part.annotations) || part.annotations.length > maxListed)) fail(path);
    if (own(part, "logprobs") && (!Array.isArray(part.logprobs) || part.logprobs.length > maxListed)) fail(path);
    if (!own(part, "prompt_cache_breakpoint")) return part;
    // Breakpoints are an input-side feature; the profile must enable caching and PTU-M rejects them.
    if (part.type !== "input_text" || route.profile.cacheBreakpoints !== true || route.profile.deploymentType === "ptu-m") fail(`${path}.prompt_cache_breakpoint`, "unsupported_parameter");
    fields(part.prompt_cache_breakpoint, ["mode"], `${path}.prompt_cache_breakpoint`);
    choice(part.prompt_cache_breakpoint.mode, ["explicit"], `${path}.prompt_cache_breakpoint.mode`);
    return { ...part, prompt_cache_breakpoint: { mode: "explicit" } };
  });
}
function inputItems(input, profile, policy, route) {
  if (typeof input === "string") { if (!input.length) fail("input"); return input; }
  if (!Array.isArray(input) || !input.length || input.length > maxItems) fail("input");
  const seen = new Set(), pending = new Set(), instructionRoles = new Set();
  const result = input.map((item, index) => {
    const param = `input[${index}]`;
    if (!object(item)) fail(param);
    const type = item.type === undefined && own(item, "role") ? "message" : item.type;
    if (type === "message") {
      fields(item, ["type", "id", "role", "content", "status", "phase"], param);
      choice(item.role, ["system", "developer", "user", "assistant"], `${param}.role`);
      let role = item.role;
      if (role === "system" || role === "developer") {
        instructionRoles.add(role);
        if (policy === "reject-mixed" && instructionRoles.size > 1) fail(`${param}.role`, "invalid_parameter", "Mixed system/developer instructions are disabled by policy");
        if (policy === "system" || policy === "developer") role = policy;
      }
      if (own(item, "id") && !identifier(item.id)) fail(`${param}.id`);
      if (own(item, "status")) choice(item.status, ["completed", "in_progress", "incomplete"], `${param}.status`);
      if (own(item, "phase") && (item.role !== "assistant" || item.phase !== null && !["commentary", "final_answer"].includes(item.phase))) fail(`${param}.phase`);
      const message = { ...item, content: content(item.content, item.role, `${param}.content`, profile, route) };
      if (role !== item.role) message.role = role;
      return message;
    }
    if (type === "function_call" || type === "custom_tool_call") {
      const isCustom = type === "custom_tool_call", inputField = isCustom ? "input" : "arguments";
      if (isCustom && !profile.features.includes("custom-tool")) fail(`${param}.type`, "unsupported_parameter");
      fields(item, ["type", "id", "call_id", "name", inputField, "status"], param);
      if (!identifier(item.call_id) || !functionName(item.name) || typeof item[inputField] !== "string") fail(param);
      if (isCustom && !profile.customToolNames.includes(item.name)) fail(`${param}.name`, "unsupported_parameter");
      if (own(item, "id") && !identifier(item.id)) fail(`${param}.id`);
      if (own(item, "status")) choice(item.status, ["completed", "in_progress", "incomplete"], `${param}.status`);
      if (seen.has(item.call_id)) fail(`${param}.call_id`);
      seen.add(item.call_id); pending.add(item.call_id); return item;
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (type === "custom_tool_call_output" && !profile.features.includes("custom-tool")) fail(`${param}.type`, "unsupported_parameter");
      fields(item, ["type", "id", "call_id", "output", "status"], param);
      if (!identifier(item.call_id) || typeof item.output !== "string" || !pending.has(item.call_id)) fail(param);
      if (own(item, "id") && !identifier(item.id)) fail(`${param}.id`);
      if (own(item, "status")) choice(item.status, ["completed", "in_progress", "incomplete"], `${param}.status`);
      pending.delete(item.call_id); return item;
    }
    fail(`${param}.type`, "unsupported_parameter");
  });
  if (pending.size) fail("input", "unsupported_parameter");
  return result;
}
function toolsFor(value, profile) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 64) fail("tools");
  const names = new Set();
  return value.map((tool, index) => {
    const param = `tools[${index}]`;
    if (!object(tool)) fail(param);
    if (tool.type === "function") {
      // Plain function declarations stay in the initial contract; the bridge only relays them.
      fields(tool, ["type", "name", "description", "parameters", "strict"], param);
      if (!functionName(tool.name) || names.has(tool.name)) fail(`${param}.name`);
      names.add(tool.name);
      if (own(tool, "description") && tool.description !== null && typeof tool.description !== "string") fail(`${param}.description`);
      if (own(tool, "strict") && tool.strict !== null && typeof tool.strict !== "boolean") fail(`${param}.strict`);
      if (own(tool, "parameters") && tool.parameters !== null) schema(tool.parameters, tool.strict === true, `${param}.parameters`);
      else if (tool.strict === true) fail(`${param}.parameters`, "unsupported_parameter");
      return { ...tool, _nativeKind: "function" };
    }
    if (tool.type === "custom") {
      fields(tool, ["type", "name", "description", "format"], param);
      if (!profile.features.includes("custom-tool") || !functionName(tool.name) || !profile.customToolNames.includes(tool.name) || names.has(tool.name)) fail(`${param}.name`, "unsupported_parameter");
      if (own(tool, "description") && tool.description !== null && typeof tool.description !== "string") fail(`${param}.description`);
      if (own(tool, "format")) {
        const format = tool.format;
        if (!object(format) || !["text", "grammar"].includes(format.type)) fail(`${param}.format`, "unsupported_parameter");
        if (format.type === "text") fields(format, ["type"], `${param}.format`);
        else {
          fields(format, ["type", "syntax", "definition"], `${param}.format`);
          choice(format.syntax, ["lark"], `${param}.format.syntax`);
          if (typeof format.definition !== "string" || !format.definition.length || format.definition.length > 4096) fail(`${param}.format.definition`);
        }
      }
      names.add(tool.name); return { ...tool, _nativeKind: "custom" };
    }
    const featureByType = { web_search: "web-search", web_search_preview: "web-search", file_search: "file-search", code_interpreter: "code-interpreter", image_generation: "image-generation", mcp: "mcp" };
    const feature = featureByType[tool.type];
    if (!feature || !profile.features.includes(feature)) fail(`${param}.type`, "unsupported_parameter");
    const allowed = feature === "web-search" ? ["type", "search_context_size", "user_location"]
      : feature === "file-search" ? ["type", "vector_store_ids", "max_num_results"]
        : feature === "code-interpreter" ? ["type", "container"]
          : feature === "image-generation" ? IMAGE_FIELDS
            : ["type", "server_label", "server_url", "allowed_tools", "require_approval"];
    fields(tool, allowed, param);
    if (feature === "web-search") {
      if (own(tool, "search_context_size")) choice(tool.search_context_size, ["low", "medium", "high"], `${param}.search_context_size`);
      if (own(tool, "user_location")) {
        fields(tool.user_location, ["type", "country", "region", "city", "timezone"], `${param}.user_location`);
        if (tool.user_location.type !== "approximate") fail(`${param}.user_location.type`);
        for (const key of ["country", "region", "city", "timezone"]) if (own(tool.user_location, key)) shortString(tool.user_location[key], `${param}.user_location.${key}`);
      }
    } else if (feature === "file-search") {
      approvedResources(tool.vector_store_ids, profile.vectorStoreIds, `${param}.vector_store_ids`);
      if (own(tool, "max_num_results") && (!Number.isSafeInteger(tool.max_num_results) || tool.max_num_results < 1 || tool.max_num_results > 50)) fail(`${param}.max_num_results`);
    } else if (feature === "code-interpreter") {
      // Azure documents container as a container ID string or an auto-container object.
      if (typeof tool.container === "string") {
        if (!profile.containerIds.includes(tool.container)) fail(`${param}.container`, "unsupported_parameter");
      } else if (object(tool.container) && tool.container.type === "auto") {
        fields(tool.container, ["type", "file_ids"], `${param}.container`);
        if (!profile.containerIds.includes("auto")) fail(`${param}.container.type`, "unsupported_parameter");
        if (own(tool.container, "file_ids")) approvedResources(tool.container.file_ids, profile.fileIds, `${param}.container.file_ids`);
      } else fail(`${param}.container`, "unsupported_parameter");
    } else if (feature === "image-generation") {
      // Requiring an explicit approved model prevents a silent provider-default image model.
      if (!own(tool, "model")) fail(`${param}.model`, "unsupported_parameter");
      if (!profile.imageModels.includes(tool.model)) fail(`${param}.model`, "unsupported_parameter");
      for (const [key, values] of Object.entries({ quality: ["low", "medium", "high", "auto"], size: ["auto", "1024x1024", "1536x1024", "1024x1536"], output_format: ["png", "jpeg", "webp"], background: ["transparent", "opaque", "auto"], moderation: ["auto", "low"] })) if (own(tool, key)) choice(tool[key], values, `${param}.${key}`);
      if (own(tool, "partial_images") && (!Number.isSafeInteger(tool.partial_images) || tool.partial_images < 0 || tool.partial_images > 3)) fail(`${param}.partial_images`);
    } else {
      const server = profile.mcpServers.find(candidate => candidate.label === tool.server_label && candidate.url === tool.server_url);
      if (!server) fail(`${param}.server_url`, "unsupported_parameter");
      // Without an explicit allowlist the model could reach every tool exposed by that server.
      if (!Array.isArray(tool.allowed_tools) || !tool.allowed_tools.length) fail(`${param}.allowed_tools`, "unsupported_parameter");
      if (new Set(tool.allowed_tools).size !== tool.allowed_tools.length || tool.allowed_tools.some(name => typeof name !== "string" || !server.toolNames.includes(name))) fail(`${param}.allowed_tools`, "unsupported_parameter");
      if (own(tool, "require_approval") && tool.require_approval !== "always") fail(`${param}.require_approval`, "unsupported_parameter");
      tool.require_approval = "always";
    }
    return { ...tool, _nativeKind: feature };
  });
}
function reasoningFor(value, route, config) {
  const result = {};
  for (const [key, globalKey] of [["effort", "reasoningEffort"], ["mode", "reasoningMode"], ["context", "reasoningContext"]]) {
    const fallback = config.defaults[globalKey] ?? (key === "effort" ? route.profile.defaultEffort : undefined);
    if (fallback !== undefined) result[key] = fallback;
  }
  if (value !== undefined && value !== null) { fields(value, ["effort", "mode", "context", "summary"], "reasoning"); Object.assign(result, value); }
  for (const [key, allowed] of [["effort", route.profile.efforts], ["mode", route.profile.reasoningModes], ["context", route.profile.reasoningContexts]]) {
    if (!own(result, key)) continue;
    if (key === "effort" && result[key] === null) { delete result[key]; continue; }
    if (typeof result[key] !== "string") fail(`reasoning.${key}`);
    if (!allowed.includes(result[key])) fail(`reasoning.${key}`, "unsupported_parameter");
  }
  if (own(result, "summary")) choice(result.summary, ["auto", "concise", "detailed"], "reasoning.summary");
  return Object.keys(result).length ? result : undefined;
}
function textFor(value, route) {
  if (value === undefined) return undefined;
  fields(value, ["format", "verbosity"], "text");
  if (!Object.keys(value).length) return undefined;
  if (own(value, "verbosity")) { if (!route.profile.verbosity) fail("text.verbosity", "unsupported_parameter"); choice(value.verbosity, ["low", "medium", "high"], "text.verbosity"); }
  if (own(value, "format")) {
    const format = value.format;
    if (!object(format) || typeof format.type !== "string") fail("text.format");
    if (["text", "json_object"].includes(format.type)) fields(format, ["type"], "text.format");
    else if (format.type === "json_schema") {
      fields(format, ["type", "name", "schema", "description", "strict"], "text.format");
      if (!functionName(format.name)) fail("text.format.name");
      if (!own(format, "schema")) fail("text.format.schema");
      if (own(format, "description") && typeof format.description !== "string") fail("text.format.description");
      if (own(format, "strict") && format.strict !== null && typeof format.strict !== "boolean") fail("text.format.strict");
      schema(format.schema, format.strict === true, "text.format.schema");
    } else fail("text.format.type", "unsupported_parameter");
  }
  return value;
}
function cacheFor(body, config, route) {
  const result = {};
  const key = own(body, "prompt_cache_key") ? body.prompt_cache_key : config.defaults.cacheKey;
  if (key !== undefined && key !== null) {
    if (typeof key !== "string" || !CACHE_KEY.test(key)) fail("prompt_cache_key", "invalid_parameter", "Use a non-secret prefix-family identifier (1-128 ASCII characters)");
    result.prompt_cache_key = key;
  }
  const options = own(body, "prompt_cache_options") ? body.prompt_cache_options : config.defaults.cacheOptions;
  if (options !== undefined && options !== null) {
    fields(options, ["mode", "ttl"], "prompt_cache_options");
    const valid = {};
    if (own(options, "mode")) { choice(options.mode, ["implicit", "explicit"], "prompt_cache_options.mode"); valid.mode = options.mode; }
    if (own(options, "ttl")) { choice(options.ttl, ["30m"], "prompt_cache_options.ttl"); valid.ttl = options.ttl; }
    if (Object.keys(valid).length) result.prompt_cache_options = valid;
    if (valid.mode === "explicit" && route.profile.deploymentType === "ptu-m") fail("prompt_cache_options.mode", "unsupported_parameter", "Explicit cache policy is not supported on PTU-M deployments");
  }
  if (own(body, "prompt_cache_retention")) { choice(body.prompt_cache_retention, ["in_memory", "24h"], "prompt_cache_retention"); result.prompt_cache_retention = body.prompt_cache_retention; }
  return result;
}
function includeFor(value, declared) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length || value.length > 16 || new Set(value).size !== value.length) fail("include");
  for (const name of value) {
    if (typeof name !== "string" || !own(INCLUDE_VALUES, name)) fail("include", "unsupported_parameter");
    const required = INCLUDE_VALUES[name];
    if (required && !declared.includes(required)) fail("include", "unsupported_parameter");
  }
  return [...value];
}
function topLogprobsFor(value, include) {
  if (value === undefined) return undefined;
  // An exact 0 is the documented default and was already dropped as inert.
  if (!Number.isSafeInteger(value) || value < 1 || value > 20) fail("top_logprobs");
  if (!include || !include.includes("message.output_text.logprobs")) fail("top_logprobs", "unsupported_parameter", "top_logprobs requires include containing message.output_text.logprobs");
  return value;
}
function metadataFor(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length > 16) fail("metadata");
  for (const [name, entry] of Object.entries(value)) {
    if (!name.length || name.length > 64) fail("metadata");
    if (typeof entry !== "string" || entry.length > 512) fail(`metadata.${name}`);
  }
  return jsonCopy(value, "metadata");
}
function samplingFor(body, route, reasoning) {
  const result = {}, effort = reasoning === undefined ? undefined : reasoning.effort;
  for (const [key, max] of [["temperature", 2], ["top_p", 1]]) {
    if (!own(body, key)) continue;
    if (typeof body[key] !== "number" || !Number.isFinite(body[key]) || body[key] < 0 || body[key] > max) fail(key);
    if (effort === undefined || !Array.isArray(route.profile.samplingEfforts) || !route.profile.samplingEfforts.includes(effort)) fail(key, "unsupported_parameter", `${key} is not supported at the effective reasoning effort`);
    result[key] = body[key];
  }
  return result;
}
function requestScope(tools) {
  const scope = { vectorStores: [], containers: [], mcpTools: new Map(), imageModels: [] };
  for (const tool of tools) {
    if (tool._nativeKind === "file-search") scope.vectorStores.push(...tool.vector_store_ids);
    else if (tool._nativeKind === "code-interpreter") scope.containers.push(typeof tool.container === "string" ? tool.container : "auto");
    else if (tool._nativeKind === "mcp") scope.mcpTools.set(tool.server_label, Object.freeze([...tool.allowed_tools]));
    else if (tool._nativeKind === "image-generation") scope.imageModels.push(tool.model);
  }
  return scope;
}
const inertDefaults = Object.freeze({ truncation: "disabled", top_logprobs: 0, service_tier: "auto", temperature: 1, top_p: 1 });
function normalizeOptionals(body) {
  // Responses marks these fields nullable; null means "unset" and is never forwarded.
  for (const key of ["prompt_cache_retention", "temperature", "top_p", "include", "top_logprobs", "metadata", "safety_identifier", "user", "max_tool_calls", "service_tier", "truncation"]) if (own(body, key) && body[key] === null) delete body[key];
  // Cache identity keeps its null: an explicit null must clear an operator default rather than inherit it.
  // Values equal to the documented default cannot change provider behaviour, so they are dropped rather than rejected.
  if (own(body, "metadata") && object(body.metadata) && !Object.keys(body.metadata).length) delete body.metadata;
  if (own(body, "include") && Array.isArray(body.include) && !body.include.length) delete body.include;
  // temperature:1 and top_p:1 stay inert even where sampling is unsupported: an exact documented default never fails.
  for (const [key, value] of Object.entries(inertDefaults)) if (own(body, key) && body[key] === value) delete body[key];
}
function validateNativeRequest(original, config) {
  const body = jsonCopy(original, "body"); if (!object(body)) fail("body");
  normalizeOptionals(body);
  for (const key of Object.keys(body)) if (!topFields.has(key)) fail(key, deferredFields.has(key) ? "unsupported_parameter" : "unknown_parameter");
  const alias = own(body, "model") ? body.model : config.defaultModel;
  if (typeof alias !== "string") fail("model");
  if (!own(config.models, alias)) fail("model", "model_not_found");
  const route = config.models[alias];
  const profile = own(config.nativePolicies || {}, alias) ? config.nativePolicies[alias] : EMPTY_PROFILE;
  if (!own(body, "input")) fail("input");
  const input = inputItems(body.input, profile, config.instructionPolicy ?? "preserve", route);
  if (own(body, "instructions") && body.instructions !== null && typeof body.instructions !== "string") fail("instructions");
  if (own(body, "stream") && body.stream !== null && typeof body.stream !== "boolean") fail("stream");
  if (own(body, "background") && body.background !== false && body.background !== null) fail("background", body.background === true ? "unsupported_parameter" : "invalid_parameter");
  if (own(body, "store") && body.store !== true && body.store !== false && body.store !== null) fail("store");
  const storeRequested = own(body, "store") && body.store === true;
  if (storeRequested && (!config.allowStore || !profile.allowStore)) fail("store", "unsupported_parameter");
  const cap = Math.min(config.maxOutputTokens, route.profile.maxOutputTokens);
  if (body.max_output_tokens !== undefined && body.max_output_tokens !== null && (!Number.isSafeInteger(body.max_output_tokens) || body.max_output_tokens < 1 || body.max_output_tokens > cap)) fail("max_output_tokens");
  const tools = toolsFor(body.tools, profile);
  const names = tools.filter(tool => tool._nativeKind === "function").map(tool => tool.name);
  const customNames = tools.filter(tool => tool._nativeKind === "custom").map(tool => tool.name);
  const declared = Object.freeze([...new Set(tools.filter(tool => tool._nativeKind !== "function").map(tool => tool._nativeKind === "custom" ? "custom-tool" : tool._nativeKind))]);
  const streaming = body.stream === true;
  // Azure documents image-generation streaming as unsupported; require an explicit operator assertion.
  if (streaming && declared.includes("image-generation") && !profile.verifiedCapabilities.includes("image-generation-streaming")) fail("stream", "unsupported_parameter");
  if (tools.some(tool => tool._nativeKind === "image-generation" && tool.partial_images > 0) && !profile.verifiedCapabilities.includes("image-generation-streaming")) fail("tools", "unsupported_parameter");
  let toolChoice = body.tool_choice;
  if (toolChoice !== undefined) {
    if (typeof toolChoice === "string") {
      choice(toolChoice, ["auto", "none", "required"], "tool_choice");
      if (toolChoice === "required" && !tools.length) fail("tool_choice");
    } else if (!object(toolChoice)) fail("tool_choice");
    else {
      fields(toolChoice, ["type", "name"], "tool_choice");
      if (!functionName(toolChoice.name)) fail("tool_choice.name");
      if (toolChoice.type === "function") { if (!names.includes(toolChoice.name)) fail("tool_choice.name"); }
      else if (toolChoice.type === "custom") { if (!declared.includes("custom-tool") || !customNames.includes(toolChoice.name)) fail("tool_choice.name", "unsupported_parameter"); }
      else fail("tool_choice.type", "unsupported_parameter");
    }
  }
  if (own(body, "parallel_tool_calls") && body.parallel_tool_calls !== null && typeof body.parallel_tool_calls !== "boolean") fail("parallel_tool_calls");
  const include = includeFor(body.include, declared);
  const topLogprobs = topLogprobsFor(body.top_logprobs, include);
  const cache = cacheFor(body, config, route);
  const metadata = metadataFor(body.metadata);
  const identity = {};
  if (own(body, "safety_identifier")) identity.safety_identifier = shortString(body.safety_identifier, "safety_identifier", 128);
  if (own(body, "user")) identity.user = shortString(body.user, "user", 512);
  if (own(body, "max_tool_calls")) { if (!Number.isSafeInteger(body.max_tool_calls) || body.max_tool_calls < 1 || body.max_tool_calls > 1000) fail("max_tool_calls"); identity.max_tool_calls = body.max_tool_calls; }
  // "auto" service tier and "disabled" truncation were already dropped as inert defaults.
  if (own(body, "service_tier")) { choice(body.service_tier, ["default", "flex", "scale", "priority", "fast"], "service_tier"); identity.service_tier = body.service_tier; }
  if (own(body, "truncation")) { choice(body.truncation, ["auto"], "truncation"); identity.truncation = body.truncation; }
  const payload = { model: route.deployment, input, store: storeRequested, max_output_tokens: body.max_output_tokens ?? Math.min(config.defaultMaxOutputTokens ?? cap, cap) };
  if (own(body, "instructions")) payload.instructions = body.instructions;
  if (own(body, "stream")) payload.stream = streaming;
  const reasoning = reasoningFor(body.reasoning, route, config), text = textFor(body.text, route);
  if (reasoning !== undefined) payload.reasoning = reasoning;
  const sampling = samplingFor(body, route, reasoning);
  if (sampling.temperature !== undefined) payload.temperature = sampling.temperature;
  if (sampling.top_p !== undefined) payload.top_p = sampling.top_p;
  if (text !== undefined) payload.text = text;
  if (own(body, "tools")) payload.tools = tools.map(({ _nativeKind, ...tool }) => tool);
  if (toolChoice !== undefined) payload.tool_choice = typeof toolChoice === "string" ? toolChoice : { type: toolChoice.type, name: toolChoice.name };
  if (typeof body.parallel_tool_calls === "boolean") payload.parallel_tool_calls = body.parallel_tool_calls;
  if (include !== undefined) payload.include = include;
  if (topLogprobs !== undefined) payload.top_logprobs = topLogprobs;
  Object.assign(payload, cache, identity);
  if (metadata !== undefined) payload.metadata = metadata;
  const permissions = Object.freeze({
    toolNames: Object.freeze(names), customNames: Object.freeze(customNames), declared,
    tools: Object.freeze(tools.map(({ _nativeKind, ...tool }) => Object.freeze({ ...tool, kind: _nativeKind }))),
    toolChoice: typeof toolChoice === "string" ? toolChoice : toolChoice ? Object.freeze({ type: toolChoice.type, name: toolChoice.name }) : undefined,
    scope: Object.freeze(requestScope(tools)),
    profile, maxItems, maxIdentityBytes: Math.min(config.limits.sseBufferBytes, config.limits.responseBytes),
  });
  return Object.freeze({ alias, route, payload, permissions });
}
function createNativeResponsePolicy(request) {
  const p = request.permissions, profile = p.profile, scope = p.scope;
  const calls = new Map(), callIds = new Map(), hosted = new Map(); let bytes = 0;
  const forced = p.toolChoice && object(p.toolChoice) ? p.toolChoice : undefined;
  const nameAllowed = (name, kind) => functionName(name) && (kind === "custom" ? p.customNames.includes(name) : p.toolNames.includes(name)) && (!forced || forced.name === name);
  const kindByItemType = { function_call: "function", custom_tool_call: "custom", web_search_call: "web-search", file_search_call: "file-search", code_interpreter_call: "code-interpreter", image_generation_call: "image-generation", mcp_call: "mcp", mcp_list_tools: "mcp", mcp_approval_request: "mcp" };
  const charge = size => { if (size <= 0) return true; if (bytes + size > p.maxIdentityBytes) return false; bytes += size; return true; };
  const toolForItem = item => p.tools.find(tool => tool.kind === kindByItemType[item.type] && (MCP_TYPES.has(item.type) ? item.server_label === tool.server_label : true));
  const toolAllowedHere = item => {
    const tool = toolForItem(item);
    // A forced call can only be a declared function or custom tool.
    return Boolean(tool) && p.toolChoice !== "none" && !(forced && !["function", "custom"].includes(tool.kind));
  };
  const citationAllowed = annotation => {
    if (!object(annotation) || typeof annotation.type !== "string") return false;
    if (annotation.type === "url_citation") {
      if (typeof annotation.url !== "string") return false;
      let url; try { url = new URL(annotation.url); } catch { return false; }
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    }
    if (annotation.type === "file_citation") return typeof annotation.file_id === "string" && profile.fileIds.includes(annotation.file_id);
    // Other annotation shapes could carry unapproved container/file identities.
    return false;
  };
  const partAllowed = part => {
    if (!object(part)) return false;
    if (part.type === "output_text") {
      if (typeof part.text !== "string") return false;
      // The provider marks these collections nullable and some versions emit an explicit null.
      // A null carries no identity or payload, so it is equivalent to omission here.
      if (own(part, "annotations") && part.annotations !== null && (!Array.isArray(part.annotations) || part.annotations.length > maxListed || !part.annotations.every(citationAllowed))) return false;
      if (own(part, "logprobs") && part.logprobs !== null && (!Array.isArray(part.logprobs) || part.logprobs.length > maxListed)) return false;
      return true;
    }
    if (part.type === "refusal") return typeof part.refusal === "string";
    if (part.type === "output_image") return p.declared.includes("image-generation") && typeof (part.image_url ?? part.result) === "string";
    return false;
  };
  const remember = (item, index) => {
    const kind = item.type === "custom_tool_call" ? "custom" : "function";
    const material = kind === "custom" ? item.input : item.arguments;
    if (!identifier(item.id) || !identifier(item.call_id) || !nameAllowed(item.name, kind) || typeof material !== "string") return false;
    const old = calls.get(item.id);
    if (old) {
      const size = Buffer.byteLength(material);
      if (size > old.payloadBytes && !charge(size - old.payloadBytes)) return false;
      old.payloadBytes = Math.max(old.payloadBytes, size);
      return old.name === item.name && old.callId === item.call_id && old.kind === kind && (old.index === undefined || index === undefined || old.index === index);
    }
    if (callIds.has(item.call_id) || calls.size >= p.maxItems) return false;
    const added = 256 + 2 * (item.id.length + item.call_id.length + item.name.length) + Buffer.byteLength(material);
    if (!charge(added)) return false;
    calls.set(item.id, { name: item.name, callId: item.call_id, index, kind, payloadBytes: Buffer.byteLength(material) });
    callIds.set(item.call_id, item.id);
    return true;
  };
  const hostedAllowed = (item, index) => {
    if (!toolAllowedHere(item)) return false;
    const tool = toolForItem(item);
    if (item.type === "file_search_call") {
      if (!Array.isArray(item.queries) || item.queries.some(query => typeof query !== "string" || query.length > 512)) return false;
      // Azure marks result details optional; validate only what the provider actually returned.
      if (own(item, "results")) {
        if (!Array.isArray(item.results) || item.results.length > p.maxItems) return false;
        if (!item.results.every(result => object(result) && typeof result.file_id === "string" && profile.fileIds.includes(result.file_id)
          && (!own(result, "vector_store_id") || (profile.vectorStoreIds.includes(result.vector_store_id) && scope.vectorStores.includes(result.vector_store_id))))) return false;
      }
    }
    if (item.type === "code_interpreter_call") {
      if (!identifier(item.container_id)) return false;
      const auto = tool.container?.type === "auto" && profile.containerIds.includes("auto") && scope.containers.includes("auto");
      if (!(profile.containerIds.includes(item.container_id) && scope.containers.includes(item.container_id)) && !auto) return false;
    }
    if (item.type === "image_generation_call") {
      if (typeof item.model !== "string" || !profile.imageModels.includes(item.model) || !scope.imageModels.includes(item.model)) return false;
    }
    if (MCP_TYPES.has(item.type)) {
      const server = profile.mcpServers.find(candidate => candidate.label === item.server_label);
      const scoped = scope.mcpTools.get(item.server_label);
      if (!server || !scoped || server.url !== tool.server_url) return false;
      if (item.type !== "mcp_list_tools" && (typeof item.name !== "string" || !server.toolNames.includes(item.name) || !scoped.includes(item.name))) return false;
    }
    if (typeof item.id === "string") {
      const prior = hosted.get(item.id);
      const size = Buffer.byteLength(JSON.stringify(item));
      if (!prior && hosted.size >= p.maxItems) return false;
      if (!charge(Math.max(0, size - (prior?.bytes || 0)))) return false;
      if (prior && (prior.type !== item.type || prior.index !== undefined && index !== undefined && prior.index !== index)) return false;
      hosted.set(item.id, { type: item.type, index: prior?.index ?? index, bytes: Math.max(prior?.bytes || 0, size) });
    }
    return true;
  };
  const itemAllowed = (item, index) => {
    if (!object(item) || own(item, "id") && !identifier(item.id)) return false;
    if (item.type === "message") return (!own(item, "role") || item.role === "assistant") && Array.isArray(item.content) && item.content.length <= p.maxItems && item.content.every(partAllowed);
    // `summary` and `content` are nullable on reasoning items; an explicit null is equivalent to omission.
    if (item.type === "reasoning") return (!own(item, "summary") || item.summary === null || Array.isArray(item.summary) && item.summary.length <= maxItems && item.summary.every(part => object(part) && part.type === "summary_text" && typeof part.text === "string"))
      && (!own(item, "content") || item.content === null || Array.isArray(item.content) && item.content.length <= maxItems && item.content.every(part => object(part) && ["reasoning_text", "reasoning_summary"].includes(part.type) && (typeof part.text === "string" || part.type === "reasoning_summary")));
    if (item.type === "compaction") return true; // opaque data, never interpreted or retained for chaining
    if (item.type === "function_call" || item.type === "custom_tool_call") return toolAllowedHere(item) && remember(item, index);
    if (HOSTED_TYPES.has(item.type)) return hostedAllowed(item, index);
    return false;
  };
  const responseAllowed = response => {
    if (!object(response) || !identifier(response.id) || typeof response.status !== "string") return false;
    if (!own(response, "output")) return response.status !== "completed";
    if (!Array.isArray(response.output) || response.output.length > p.maxItems) return false;
    const ids = new Set(), generated = new Set();
    for (const item of response.output) {
      if (!itemAllowed(item)) return false;
      if (typeof item.id === "string") { if (ids.has(item.id)) return false; ids.add(item.id); }
      if ((item.type === "function_call" || item.type === "custom_tool_call") && typeof item.call_id === "string") { if (generated.has(item.call_id)) return false; generated.add(item.call_id); }
    }
    return true;
  };
  const featureForEvent = name => /^response\.code_interpreter/.test(name) ? "code-interpreter"
    : /^response\.file_search/.test(name) ? "file-search"
      : /^response\.web_search/.test(name) ? "web-search"
        : /^response\.image_generation/.test(name) ? "image-generation"
          : /^response\.mcp_/.test(name) ? "mcp"
            : /^response\.custom_tool_/.test(name) ? "custom-tool" : null;
  const familyOf = id => { const seen = hosted.get(id); if (seen) return seen.type; const call = calls.get(id); return call ? (call.kind === "custom" ? "custom_tool_call" : "function_call") : undefined; };
  const toolArgEvents = ["response.function_call_arguments.delta", "response.function_call_arguments.done", "response.custom_tool_call_input.delta", "response.custom_tool_call_input.done"];
  return (info, payload) => {
    if (!object(payload)) return false;
    const entry = EVENT_REGISTRY[info.name] || COMPATIBILITY_EVENTS[info.name];
    const feature = featureForEvent(info.name);
    if (feature) {
      if (!p.declared.includes(feature) || !profile.features.includes(feature)) return false;
      // Payload identity, when present, must match an item already observed for this feature.
      if (own(payload, "item_id")) {
        const family = familyOf(payload.item_id);
        if (!family || !FEATURE_ITEM_TYPE[feature].includes(family)) return false;
      }
      if (feature === "custom-tool" && typeof payload.delta === "string" && !charge(Buffer.byteLength(payload.delta))) return false;
      return true;
    }
    if (entry && (entry.category.startsWith("lifecycle") || info.name === "response.cancelled")) return responseAllowed(payload.response);
    if (info.name === "response.output_item.added" || info.name === "response.output_item.done") return itemAllowed(payload.item, payload.output_index);
    if (info.name === "response.content_part.added" || info.name === "response.content_part.done") return partAllowed(payload.part);
    if (info.name === "response.output_text.annotation.added") return citationAllowed(payload.annotation);
    if (toolArgEvents.includes(info.name)) {
      const observed = calls.get(payload.item_id);
      if (!observed) return false;
      const material = payload.delta ?? payload.arguments ?? payload.input ?? "";
      if (typeof material !== "string" || !charge(Buffer.byteLength(material))) return false;
      const wantKind = info.name.startsWith("response.custom_tool_") ? "custom" : "function";
      return observed.kind === wantKind && nameAllowed(observed.name, observed.kind) && (observed.index === undefined || observed.index === payload.output_index) && (!own(payload, "name") || payload.name === observed.name);
    }
    if (!entry) {
      // No audio modality is implemented, so audio-prefixed events stay denied even as future types.
      if (/^response\.audio[._]/.test(info.name)) return false;
      if (object(payload.item) && typeof payload.item.type === "string" && !itemAllowed(payload.item)) return false;
      if (Array.isArray(payload.response?.output) && !responseAllowed(payload.response)) return false;
      return true;
    }
    return ["error", "output-text", "refusal", "reasoning-summary", "raw-reasoning"].includes(entry.category);
  };
}
function validateNativeResponse(response, policy) {
  const bad = () => { throw Object.assign(new Error("Upstream native response shape is invalid"), { code: "invalid_native_response", status: 502, type: "upstream_error" }); };
  if (!object(response) || !identifier(response.id) || !terminalStatuses.has(response.status) || !Array.isArray(response.output)) bad();
  if (own(response, "object") && response.object !== "response") bad();
  if (own(response, "model") && (typeof response.model !== "string" || !response.model)) bad();
  if (own(response, "created_at") && (typeof response.created_at !== "number" || !Number.isFinite(response.created_at) || response.created_at < 0)) bad();
  if (own(response, "error") && response.error !== null && !object(response.error)) bad();
  if (own(response, "incomplete_details") && response.incomplete_details !== null && !object(response.incomplete_details)) bad();
  if (own(response, "usage") && response.usage !== null && !object(response.usage)) bad();
  if (!policy({ name: `response.${response.status}`, known: true, category: "lifecycle-terminal" }, { response })) throw Object.assign(new Error("Upstream native response exceeded request permissions"), { code: "native_policy_rejected", status: 502, type: "upstream_error" });
  return response;
}
function redactNativeResponse(response, secrets) {
  if (!object(response.error) || typeof response.error.message !== "string") return response;
  let message = response.error.message;
  for (const secret of secrets) if (typeof secret === "string" && secret.length >= 8) message = message.split(secret).join("[redacted]");
  return message === response.error.message ? response : { ...response, error: { ...response.error, message } };
}
module.exports = { validateNativeRequest, createNativeResponsePolicy, validateNativeResponse, redactNativeResponse };
