"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { validateConfig } = require("./config");
const { validateNativeRequest, createNativeResponsePolicy, validateNativeResponse, redactNativeResponse } = require("./native-request");
function config(extra = {}) {
  return validateConfig({ azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"], azureApiKey: "fixture-upstream", proxyToken: "fixture-local", defaultModel: "local", models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v" } }, ...extra });
}
const tool = (name = "lookup", extra = {}) => ({ type: "function", name, parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"], additionalProperties: false }, strict: true, ...extra });
const withFunctions = () => config({ nativePolicies: { local: { features: [], customToolNames: ["lookup", "other", "nullable", "open", "unspecified"] } } });
const call = (extra = {}) => ({ id: "item-1", type: "function_call", call_id: "call-1", name: "lookup", arguments: "{}", status: "completed", ...extra });
const message = (extra = {}) => ({ type: "message", id: "message-1", role: "assistant", content: [{ type: "output_text", text: "hello", annotations: [], logprobs: [], provider_extra: { retained: true } }], phase: "final_answer", ...extra });
const parent = (output = [], extra = {}) => ({ id: "r", object: "response", model: "provider-model", status: "completed", output, ...extra });
const policy = (body = {}, cfg = config()) => createNativeResponsePolicy(validateNativeRequest({ input: "x", ...body }, cfg));
const inspect = (p, name, value) => p({ name, known: true, category: "unused" }, value);

test("native route selection, profile output cap and stateless defaults never infer deployment", () => {
  const cfg = config({ maxOutputTokens: 100, allowStore: true, defaults: { store: true } });
  const r = validateNativeRequest({ input: "hello" }, cfg);
  assert.equal(r.alias, "local"); assert.equal(r.payload.model, "deployment"); assert.equal(r.payload.max_output_tokens, 100); assert.equal(r.payload.store, false);
  assert.throws(() => validateNativeRequest({ input: "x", model: "deployment" }, cfg), { code: "model_not_found", param: "model" });
  assert.throws(() => validateNativeRequest({ input: "x", model: null }, cfg), { code: "invalid_parameter" });
  assert.throws(() => validateNativeRequest({ input: "x", max_output_tokens: 101 }, cfg), { code: "invalid_parameter" });
});
test("native booleans and nullable inert defaults are explicit and storage stays disabled", () => {
  const r = validateNativeRequest({ input: "x", stream: null, store: null, background: false, max_output_tokens: null, parallel_tool_calls: null }, config());
  assert.equal(r.payload.stream, false); assert.equal(r.payload.store, false); assert.equal(r.payload.max_output_tokens, 128000); assert.equal(Object.hasOwn(r.payload, "parallel_tool_calls"), false);
  for (const key of ["store", "background"]) assert.throws(() => validateNativeRequest({ input: "x", [key]: true }, config()), { code: "unsupported_parameter", param: key });
  const consent = config({ allowStore: true, nativePolicies: { local: { allowStore: true } }, defaults: { store: true } });
  assert.equal(validateNativeRequest({ input: "x" }, consent).payload.store, false);
  assert.equal(validateNativeRequest({ input: "x", store: true }, consent).payload.store, true);
  assert.throws(() => validateNativeRequest({ input: "x", store: true }, config({ allowStore: true })), { code: "unsupported_parameter", param: "store" });
  assert.throws(() => validateNativeRequest({ input: "x", store: true }, config({ nativePolicies: { local: { allowStore: true } } })), { code: "unsupported_parameter", param: "store" });
  for (const key of ["stream", "store", "background", "parallel_tool_calls"]) assert.throws(() => validateNativeRequest({ input: "x", [key]: "false" }, config()), { code: "invalid_parameter" });
});
test("inert deferred defaults are accepted and dropped while unsupported shapes still fail", () => {
  const inert = { metadata: {}, include: [], truncation: "disabled", top_logprobs: 0, service_tier: "auto", temperature: 1, top_p: 1 };
  const r = validateNativeRequest({ input: "x", ...inert }, config());
  for (const key of Object.keys(inert)) assert.equal(Object.hasOwn(r.payload, key), false);
  // A non-object metadata fails shape validation; sampling stays unsupported at the default effort.
  const rejected = [["metadata", [], "invalid_parameter"], ["temperature", 0.5, "unsupported_parameter"], ["top_p", 0.9, "unsupported_parameter"]];
  for (const [key, value, code] of rejected) assert.throws(() => validateNativeRequest({ input: "x", [key]: value }, config()), { code, param: key }, `${key}=${JSON.stringify(value)}`);
});
test("prompt_cache_key requires a bounded identifier and lets the client override the operator default", () => {
  assert.equal(validateNativeRequest({ input: "x", prompt_cache_key: "tenant-a.cache:1" }, config()).payload.prompt_cache_key, "tenant-a.cache:1");
  for (const bad of ["", "-leading", "a".repeat(129), 7]) assert.throws(() => validateNativeRequest({ input: "x", prompt_cache_key: bad }, config()), { code: "invalid_parameter", param: "prompt_cache_key" });
  assert.equal(validateNativeRequest({ input: "x" }, config({ defaults: { cacheKey: "operator-cache" } })).payload.prompt_cache_key, "operator-cache");
  assert.equal(validateNativeRequest({ input: "x", prompt_cache_key: "client-cache" }, config({ defaults: { cacheKey: "operator-cache" } })).payload.prompt_cache_key, "client-cache");
  // An explicit null clears operator cache identity instead of inheriting it.
  const cleared = validateNativeRequest({ input: "x", prompt_cache_key: null, prompt_cache_options: null }, config({ defaults: { cacheKey: "operator-cache", cacheOptions: { mode: "implicit" } } }));
  assert.equal(Object.hasOwn(cleared.payload, "prompt_cache_key"), false);
  assert.equal(Object.hasOwn(cleared.payload, "prompt_cache_options"), false);
  const inherited = validateNativeRequest({ input: "x" }, config({ defaults: { cacheOptions: { mode: "implicit", ttl: "30m" } } }));
  assert.deepEqual(inherited.payload.prompt_cache_options, { mode: "implicit", ttl: "30m" });
});
test("prompt_cache_options and prompt_cache_retention accept only documented cache shapes", () => {
  assert.deepEqual(validateNativeRequest({ input: "x", prompt_cache_options: { mode: "explicit" } }, config()).payload.prompt_cache_options, { mode: "explicit" });
  assert.deepEqual(validateNativeRequest({ input: "x", prompt_cache_options: { ttl: "30m" } }, config()).payload.prompt_cache_options, { ttl: "30m" });
  assert.throws(() => validateNativeRequest({ input: "x", prompt_cache_options: { mode: "bogus" } }, config()), { code: "invalid_parameter", param: "prompt_cache_options.mode" });
  assert.throws(() => validateNativeRequest({ input: "x", prompt_cache_options: { ttl: "1h" } }, config()), { code: "invalid_parameter", param: "prompt_cache_options.ttl" });
  assert.equal(Object.hasOwn(validateNativeRequest({ input: "x", prompt_cache_options: {} }, config()).payload, "prompt_cache_options"), false);
  const ptu = config({ models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v", profile: { deploymentType: "ptu-m" } } } });
  assert.throws(() => validateNativeRequest({ input: "x", prompt_cache_options: { mode: "explicit" } }, ptu), { code: "unsupported_parameter", param: "prompt_cache_options.mode" });
  assert.equal(validateNativeRequest({ input: "x", prompt_cache_retention: "24h" }, config()).payload.prompt_cache_retention, "24h");
  assert.equal(validateNativeRequest({ input: "x", prompt_cache_retention: "in_memory" }, config()).payload.prompt_cache_retention, "in_memory");
  assert.throws(() => validateNativeRequest({ input: "x", prompt_cache_retention: "1h" }, config()), { code: "invalid_parameter", param: "prompt_cache_retention" });
});
test("input_text cache breakpoints need an enabled route profile and are normalized", () => {
  const body = { input: [{ role: "user", content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }] }] };
  assert.deepEqual(validateNativeRequest(body, config()).payload.input[0].content[0], { type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } });
  const path = "input[0].content[0].prompt_cache_breakpoint";
  assert.throws(() => validateNativeRequest({ input: [{ role: "assistant", content: [{ type: "output_text", text: "hi", prompt_cache_breakpoint: { mode: "explicit" } }] }] }, config()), { code: "unsupported_parameter", param: path });
  const off = config({ models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v", profile: { cacheBreakpoints: false } } } });
  assert.throws(() => validateNativeRequest(body, off), { code: "unsupported_parameter", param: path });
  assert.throws(() => validateNativeRequest({ input: [{ role: "user", content: [{ type: "input_text", text: "hi", prompt_cache_breakpoint: { mode: "implicit" } }] }] }, config()), { code: "invalid_parameter", param: `${path}.mode` });
});
test("include accepts known values and gates tool-scoped names on declared tools", () => {
  assert.deepEqual(validateNativeRequest({ input: "x", include: ["reasoning.encrypted_content"] }, config()).payload.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(validateNativeRequest({ input: "x", include: ["message.output_text.logprobs"] }, config()).payload.include, ["message.output_text.logprobs"]);
  assert.throws(() => validateNativeRequest({ input: "x", include: ["file_search_call.results"] }, config()), { code: "unsupported_parameter", param: "include" });
  const search = config({ nativePolicies: { local: { features: ["file-search"], vectorStoreIds: ["vs_1"] } } });
  assert.deepEqual(validateNativeRequest({ input: "x", include: ["file_search_call.results"], tools: [{ type: "file_search", vector_store_ids: ["vs_1"] }] }, search).payload.include, ["file_search_call.results"]);
  assert.throws(() => validateNativeRequest({ input: "x", include: ["unknown.value"] }, config()), { code: "unsupported_parameter", param: "include" });
  for (const bad of [["reasoning.encrypted_content", "reasoning.encrypted_content"], new Array(17).fill("reasoning.encrypted_content"), "reasoning.encrypted_content"]) assert.throws(() => validateNativeRequest({ input: "x", include: bad }, config()), { code: "invalid_parameter", param: "include" });
});
test("top_logprobs requires the logprobs include and stays within 1 to 20", () => {
  assert.equal(validateNativeRequest({ input: "x", top_logprobs: 5, include: ["message.output_text.logprobs"] }, config()).payload.top_logprobs, 5);
  assert.throws(() => validateNativeRequest({ input: "x", top_logprobs: 5 }, config()), { code: "unsupported_parameter", param: "top_logprobs" });
  for (const bad of [21, "5"]) assert.throws(() => validateNativeRequest({ input: "x", top_logprobs: bad, include: ["message.output_text.logprobs"] }, config()), { code: "invalid_parameter", param: "top_logprobs" });
});
test("metadata is bounded, copied and never forwarded empty or malformed", () => {
  const r = validateNativeRequest({ input: "x", metadata: { tenant: "a" } }, config());
  assert.deepEqual(r.payload.metadata, { tenant: "a" });
  const many = Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"]));
  assert.throws(() => validateNativeRequest({ input: "x", metadata: many }, config()), { code: "invalid_parameter", param: "metadata" });
  assert.throws(() => validateNativeRequest({ input: "x", metadata: { tenant: 7 } }, config()), { code: "invalid_parameter", param: "metadata.tenant" });
  assert.throws(() => validateNativeRequest({ input: "x", metadata: { ["k".repeat(65)]: "v" } }, config()), { code: "invalid_parameter", param: "metadata" });
});
test("stateless identity fields are bounded and forwarded only when valid", () => {
  assert.equal(validateNativeRequest({ input: "x", safety_identifier: "a".repeat(128) }, config()).payload.safety_identifier, "a".repeat(128));
  assert.throws(() => validateNativeRequest({ input: "x", safety_identifier: "a".repeat(129) }, config()), { code: "invalid_parameter", param: "safety_identifier" });
  assert.throws(() => validateNativeRequest({ input: "x", user: "a".repeat(513) }, config()), { code: "invalid_parameter", param: "user" });
  assert.equal(validateNativeRequest({ input: "x", max_tool_calls: 5 }, config()).payload.max_tool_calls, 5);
  for (const bad of [0, 1001]) assert.throws(() => validateNativeRequest({ input: "x", max_tool_calls: bad }, config()), { code: "invalid_parameter", param: "max_tool_calls" });
});
test("service_tier and truncation accept only documented non-default values", () => {
  assert.equal(validateNativeRequest({ input: "x", service_tier: "flex" }, config()).payload.service_tier, "flex");
  assert.throws(() => validateNativeRequest({ input: "x", service_tier: "bogus" }, config()), { code: "invalid_parameter", param: "service_tier" });
  assert.equal(validateNativeRequest({ input: "x", truncation: "auto" }, config()).payload.truncation, "auto");
  assert.throws(() => validateNativeRequest({ input: "x", truncation: "bogus" }, config()), { code: "invalid_parameter", param: "truncation" });
});
test("sampling values need an explicit sampling-capable effort", () => {
  for (const [key, value] of [["temperature", 0.5], ["top_p", 0.9]]) assert.throws(() => validateNativeRequest({ input: "x", [key]: value }, config()), { code: "unsupported_parameter", param: key });
  const sampling = config({ defaults: { reasoningEffort: "none" } });
  const r = validateNativeRequest({ input: "x", temperature: 0.5, top_p: 0.9 }, sampling);
  assert.equal(r.payload.temperature, 0.5); assert.equal(r.payload.top_p, 0.9); assert.equal(r.payload.reasoning.effort, "none");
});
test("encrypted reasoning include permits reasoning output items", () => {
  const p = policy({ include: ["reasoning.encrypted_content"] });
  assert.equal(inspect(p, "response.completed", { response: parent([{ type: "reasoning", id: "rs_1", encrypted_content: "gAAAAcipher", summary: [] }]) }), true);
});
test("prompt template identity stays deferred until it has its own grant", () => {
  assert.throws(() => validateNativeRequest({ input: "x", prompt: { id: "pmpt_1" } }, config()), { code: "unsupported_parameter", param: "prompt" });
});
test("nullable parallel_tool_calls and empty text are accepted but omitted from the payload", () => {
  const bare = validateNativeRequest({ input: "x", parallel_tool_calls: null, text: {} }, config());
  assert.equal(Object.hasOwn(bare.payload, "parallel_tool_calls"), false); assert.equal(Object.hasOwn(bare.payload, "text"), false);
  const real = validateNativeRequest({ input: "x", parallel_tool_calls: false, text: { verbosity: "high" } }, config());
  assert.equal(real.payload.parallel_tool_calls, false); assert.deepEqual(real.payload.text, { verbosity: "high" });
});
test("empty native input is rejected locally while whitespace stays content", () => {
  assert.throws(() => validateNativeRequest({ input: [] }, config()), { code: "invalid_parameter", param: "input" });
  assert.throws(() => validateNativeRequest({ input: "" }, config()), { code: "invalid_parameter", param: "input" });
  assert.equal(validateNativeRequest({ input: " " }, config()).payload.input, " ");
});
test("native instruction policy rejects mixed roles and rewrites instruction roles without mutating input", () => {
  const mixed = [{ role: "system", content: "a" }, { role: "developer", content: "b" }];
  assert.throws(() => validateNativeRequest({ input: mixed }, config({ instructionPolicy: "reject-mixed" })), { code: "invalid_parameter", param: "input[1].role", message: "Mixed system/developer instructions are disabled by policy" });
  assert.throws(() => validateNativeRequest({ input: [{ role: "user", content: "q" }, { role: "developer", content: "b" }, { role: "system", content: "a" }] }, config()), { code: "invalid_parameter", param: "input[2].role" });
  assert.deepEqual(validateNativeRequest({ input: [{ role: "system", content: "a" }, { role: "system", content: "b" }] }, config()).payload.input.map(item => item.role), ["system", "system"]);
  const input = [{ type: "message", id: "m", role: "system", status: "completed", content: "a" }, { role: "user", content: "b" }];
  const developer = validateNativeRequest({ input }, config({ instructionPolicy: "developer" }));
  assert.equal(developer.payload.input[0].role, "developer"); assert.equal(developer.payload.input[0].id, "m"); assert.equal(developer.payload.input[0].status, "completed"); assert.equal(developer.payload.input[0].content, "a"); assert.equal(developer.payload.input[1].role, "user");
  assert.equal(input[0].role, "system");
  assert.equal(validateNativeRequest({ input: [{ role: "developer", content: "a" }] }, config({ instructionPolicy: "system" })).payload.input[0].role, "system");
  assert.deepEqual(validateNativeRequest({ input: mixed }, config({ instructionPolicy: "preserve" })).payload.input.map(item => item.role), ["system", "developer"]);
});
test("native default output budget comes from config while explicit values keep the ceiling", () => {
  const cfg = config({ maxOutputTokens: 128000, defaultMaxOutputTokens: 4096 });
  assert.equal(validateNativeRequest({ input: "x" }, cfg).payload.max_output_tokens, 4096);
  assert.equal(validateNativeRequest({ input: "x", max_output_tokens: 8192 }, cfg).payload.max_output_tokens, 8192);
  assert.throws(() => validateNativeRequest({ input: "x", max_output_tokens: 128001 }, cfg), { code: "invalid_parameter", param: "max_output_tokens" });
});
test("typed and shorthand native messages preserve refusal field, phases, IDs and order", () => {
  const input = [{ role: "user", content: [{ type: "input_text", text: "question" }] }, { type: "message", id: "m", role: "assistant", status: "completed", phase: "commentary", content: [{ type: "output_text", text: "thinking", annotations: [], logprobs: [] }, { type: "refusal", refusal: "cannot comply" }] }];
  const r = validateNativeRequest({ input }, config()); assert.deepEqual(r.payload.input, input); assert.equal(Object.hasOwn(r.payload.input[0], "type"), false);
  input[0].content[0].text = "mutated"; assert.equal(r.payload.input[0].content[0].text, "question");
  assert.throws(() => validateNativeRequest({ input: [{ role: "user", content: [{ type: "refusal", refusal: "x" }] }] }, config()), { code: "unsupported_parameter" });
  assert.throws(() => validateNativeRequest({ input: [{ role: "assistant", content: [{ type: "refusal", text: "wrong" }] }] }, config()));
});
test("function histories require correlated results but do not reorder parallel native output", () => {
  const input = [{ role: "user", content: "x" }, call(), { role: "assistant", content: "commentary", phase: "commentary" }, call({ id: "item-2", call_id: "call-2" }), { type: "function_call_output", call_id: "call-2", output: "second" }, { type: "function_call_output", call_id: "call-1", output: "first" }];
  assert.deepEqual(validateNativeRequest({ input }, config()).payload.input, input);
  assert.throws(() => validateNativeRequest({ input: [call()] }, config()), { code: "unsupported_parameter" });
  assert.throws(() => validateNativeRequest({ input: [{ type: "function_call_output", call_id: "absent", output: "x" }] }, config()), { code: "invalid_parameter" });
  assert.throws(() => validateNativeRequest({ input: [call(), call()] }, config()), { code: "invalid_parameter" });
});
test("hosted/custom tools, media, references, state, connections and unknown fields fail before forwarding", () => {
  for (const type of ["web_search", "file_search", "code_interpreter", "image_generation", "mcp", "custom", "computer", "azure_function"]) assert.throws(() => validateNativeRequest({ input: "x", tools: [{ type, name: "x", parameters: null }] }, config()), { code: "unsupported_parameter" });
  for (const type of ["input_image", "input_audio", "input_file"]) assert.throws(() => validateNativeRequest({ input: [{ role: "user", content: [{ type, text: "x" }] }] }, config()), { code: "unsupported_parameter" });
  for (const type of ["item_reference", "reasoning", "compaction", "mcp_approval_response"]) assert.throws(() => validateNativeRequest({ input: [{ type, id: "r" }] }, config()), { code: "unsupported_parameter" });
  for (const key of ["previous_response_id", "conversation", "agent_reference", "agent_session_id", "context_management", "prompt", "routing_config", "stream_options"]) assert.throws(() => validateNativeRequest({ input: "x", [key]: null }, config()), { code: "unsupported_parameter", param: key });
  assert.throws(() => validateNativeRequest({ input: "x", mystery: "PRIVATE" }, config()), { code: "unknown_parameter" });
});
test("function definitions preserve native nullable fields and validate strict schemas without inventing strictness", () => {
  const tools = [tool(), tool("nullable", { parameters: null, strict: null, description: null }), tool("open", { strict: false, parameters: { type: "object", additionalProperties: true } }), { type: "function", name: "unspecified" }];
  const enabled = config({ nativePolicies: { local: { features: [], customToolNames: ["lookup", "nullable", "open", "unspecified"] } } });
  assert.deepEqual(validateNativeRequest({ input: "x", tools }, enabled).payload.tools, tools);
  assert.throws(() => validateNativeRequest({ input: "x", tools: [tool(), tool()] }, enabled));
  assert.throws(() => validateNativeRequest({ input: "x", tools: [tool("bad", { parameters: { type: "object", properties: { q: { type: "string" } }, additionalProperties: false } })] }, config()), { code: "unsupported_parameter" });
  assert.throws(() => validateNativeRequest({ input: "x", tools: [tool("bad", { parameters: { type: "object", properties: null }, strict: false })] }, config()));
  assert.throws(() => validateNativeRequest({ input: "x", tools: [tool("bad", { parameters: { type: "object", required: ["x", "x"] }, strict: false })] }, config()));
  assert.throws(() => validateNativeRequest({ input: "x", tools: [tool("bad", { parameters: { type: "object", $ref: "https://external.invalid/schema" }, strict: false })] }, config()), { code: "unsupported_parameter" });
});
test("native forced tool choice uses name at the root and never the Chat function wrapper", () => {
  const choice = { type: "function", name: "lookup" };
  const enabled = config({ nativePolicies: { local: { features: [], customToolNames: ["lookup", "other"] } } });
  const r = validateNativeRequest({ input: "x", tools: [tool()], tool_choice: choice }, enabled); assert.deepEqual(r.payload.tool_choice, choice);
  choice.name = "mutated"; assert.equal(r.permissions.toolChoice.name, "lookup");
  assert.throws(() => validateNativeRequest({ input: "x", tools: [tool()], tool_choice: { type: "function", function: { name: "lookup" } } }, enabled), { code: "unsupported_parameter" });
  assert.throws(() => validateNativeRequest({ input: "x", tool_choice: "required" }, config()));
  assert.throws(() => validateNativeRequest({ input: "x", tools: [tool()], tool_choice: { type: "function", name: "other" } }, enabled));
});
test("operator-enabled tools validate all supported native request groups and resources", () => {
  const native = config({ models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v", profile: { images: true }, nativeHeaders: { "x-ms-oai-image-generation-deployment": "img-deploy" } } }, nativePolicies: { local: { features: ["custom-tool", "web-search", "file-search", "code-interpreter", "image-generation", "mcp", "image-input", "file-input"], customToolNames: ["lookup", "grammar"], vectorStoreIds: ["vs_1"], containerIds: ["ctr_1", "auto"], fileIds: ["file_1"], mediaUrls: ["https://media.example/image.png"], imageModels: ["gpt-image-1"], mcpServers: [{ label: "tools", url: "https://mcp.example/api", toolNames: ["search"] }] } } });
  const tools = [tool(), { type: "custom", name: "grammar", format: { type: "grammar", syntax: "lark", definition: "start: WORD" } }, { type: "web_search_preview", search_context_size: "medium" }, { type: "file_search", vector_store_ids: ["vs_1"], max_num_results: 5 }, { type: "code_interpreter", container: "ctr_1" }, { type: "image_generation", model: "gpt-image-1", quality: "medium" }, { type: "mcp", server_label: "tools", server_url: "https://mcp.example/api", allowed_tools: ["search"], require_approval: "always" }];
  const request = validateNativeRequest({ input: [{ role: "user", content: [{ type: "input_text", text: "inspect" }, { type: "input_image", image_url: "https://media.example/image.png", detail: "auto" }, { type: "input_file", file_id: "file_1" }] }], tools }, native);
  assert.deepEqual(request.payload.tools, tools); assert.equal(request.payload.input[0].content[1].image_url, "https://media.example/image.png");
  assert.deepEqual(request.permissions.declared, ["custom-tool", "web-search", "file-search", "code-interpreter", "image-generation", "mcp"]);
  for (const bad of [{ ...tools[2], type: "web_search", search_context_size: "extreme" }, { ...tools[3], vector_store_ids: ["vs_other"] }, { ...tools[4], container: "other" }, { ...tools[5], model: "unapproved-image" }, { ...tools[6], server_url: "https://other.example/api" }, { type: "custom", name: "not-whitelisted" }]) assert.throws(() => validateNativeRequest({ input: "x", tools: [bad] }, native));
  assert.throws(() => validateNativeRequest({ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://unapproved.example/a" }] }] }, native));
  assert.throws(() => validateNativeRequest({ input: [{ role: "user", content: [{ type: "input_file", file_id: "unapproved" }] }] }, native));
  assert.throws(() => validateNativeRequest({ input: "x", tools: [{ type: "mcp", server_label: "tools", server_url: "https://mcp.example/api", allowed_tools: ["search"], require_approval: "never" }] }, native));
});
test("MCP requires an explicit allowlist and auto-container needs an explicit auto grant", () => {
  const native = config({ nativePolicies: { local: { features: ["mcp", "code-interpreter"], containerIds: ["ctr_1"], fileIds: ["file_1"], mcpServers: [{ label: "tools", url: "https://mcp.example/api", toolNames: ["search", "write"] }] } } });
  const base = { type: "mcp", server_label: "tools", server_url: "https://mcp.example/api" };
  assert.throws(() => validateNativeRequest({ input: "x", tools: [{ ...base }] }, native), { param: "tools[0].allowed_tools" });
  assert.throws(() => validateNativeRequest({ input: "x", tools: [{ ...base, allowed_tools: ["other"] }] }, native), { param: "tools[0].allowed_tools" });
  const ok = validateNativeRequest({ input: "x", tools: [{ ...base, allowed_tools: ["search", "write"] }] }, native);
  assert.equal(ok.payload.tools[0].require_approval, "always");
  assert.throws(() => validateNativeRequest({ input: "x", tools: [{ type: "code_interpreter", container: { type: "auto", file_ids: ["file_1"] } }] }, native), { param: "tools[0].container.type" });
  assert.ok(validateNativeRequest({ input: "x", tools: [{ type: "code_interpreter", container: { type: "auto" } }] }, config({ nativePolicies: { local: { features: ["code-interpreter"], containerIds: ["auto"] } } })));
});
test("image-generation streaming needs an explicit verified capability assertion", () => {
  const base = { features: ["image-generation"], imageModels: ["gpt-image-1"] };
  const model = { deployment: "deployment", variant: "gpt-6-luna", version: "v", nativeHeaders: { "x-ms-oai-image-generation-deployment": "img-deploy" } };
  const tools = [{ type: "image_generation", model: "gpt-image-1" }];
  assert.throws(() => validateNativeRequest({ input: "x", stream: true, tools }, config({ models: { local: model }, nativePolicies: { local: base } })), { code: "unsupported_parameter", param: "stream" });
  assert.throws(() => validateNativeRequest({ input: "x", tools: [{ type: "image_generation", partial_images: 2 }] }, config({ models: { local: model }, nativePolicies: { local: base } })), { code: "unsupported_parameter" });
  const verified = config({ models: { local: model }, nativePolicies: { local: { ...base, verifiedCapabilities: ["image-generation-streaming"] } } });
  assert.ok(validateNativeRequest({ input: "x", stream: true, tools }, verified));
});
test("routing headers are attached only when image generation is declared", () => {
  const cfg = config({ nativePolicies: { local: { features: ["image-generation"], imageModels: ["gpt-image-1"] } },
    models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v", nativeHeaders: { "x-ms-oai-image-generation-deployment": "img-deploy" } } } });
  const r = validateNativeRequest({ input: "x", tools: [{ type: "image_generation", model: "gpt-image-1" }] }, cfg);
  assert.equal(r.routingHeaders["x-ms-oai-image-generation-deployment"], "img-deploy");
  assert.ok(Object.isFrozen(r.routingHeaders));
  const text = validateNativeRequest({ input: "x" }, cfg);
  assert.deepEqual(text.routingHeaders, {});
  assert.ok(Object.isFrozen(text.routingHeaders));
});
test("declaring profile permission alone cannot authorize hosted output items", () => {
  const enabled = config({ nativePolicies: { local: { features: ["web-search"], vectorStoreIds: ["vs_1"] } } });
  const p = createNativeResponsePolicy(validateNativeRequest({ input: "x" }, enabled));
  assert.equal(inspect(p, "response.completed", { response: parent([{ type: "web_search_call", id: "web", status: "completed", action: { type: "search", query: "hello" } }]) }), false);
});
test("native text, json_object and checked json_schema formats retain fields faithfully", () => {
  for (const format of [{ type: "text" }, { type: "json_object" }, { type: "json_schema", name: "result", strict: true, schema: { type: "object", properties: {}, required: [], additionalProperties: false } }]) {
    const text = { format, verbosity: "low" }; assert.deepEqual(validateNativeRequest({ input: "x", text }, config()).payload.text, text);
  }
  assert.throws(() => validateNativeRequest({ input: "x", text: { format: { type: "json_schema", name: "x", schema: { type: "array" } } } }, config()), { code: "unsupported_parameter" });
});
test("native reasoning honors route/global defaults and refuses disallowed effort instead of substitution", () => {
  const cfg = config({ defaults: { reasoningEffort: "low", reasoningMode: "standard", reasoningContext: "current_turn" } });
  assert.deepEqual(validateNativeRequest({ input: "x" }, cfg).payload.reasoning, { effort: "low", mode: "standard", context: "current_turn" });
  const r = validateNativeRequest({ input: "x", reasoning: { effort: "high", summary: "detailed" } }, cfg); assert.equal(r.payload.reasoning.effort, "high"); assert.equal(r.payload.reasoning.summary, "detailed");
  const sol = config({ models: { local: { deployment: "d", variant: "gpt-6.1-sol", version: "v" } } });
  assert.throws(() => validateNativeRequest({ input: "x", reasoning: { effort: "none" } }, sol), { code: "unsupported_parameter" });
  assert.throws(() => validateNativeRequest({ input: "x", reasoning: { effort: 1 } }, cfg), { code: "invalid_parameter" });
});
test("JSON copying prevents getter execution, cycles, non-JSON types and unbounded recursion", () => {
  let calls = 0; const getter = { input: "x" }; Object.defineProperty(getter, "tools", { enumerable: true, get() { calls++; throw new Error("PRIVATE"); } });
  assert.throws(() => validateNativeRequest(getter, config()), { code: "invalid_parameter" }); assert.equal(calls, 0);
  const cycle = { input: "x" }; cycle.tools = cycle; assert.throws(() => validateNativeRequest(cycle, config()), { code: "invalid_parameter" });
  const deep = { input: "x" }; let node = deep; for (let i = 0; i < 70; i++) node = node.nested = {}; assert.throws(() => validateNativeRequest(deep, config()), { code: "invalid_parameter" });
  assert.throws(() => validateNativeRequest({ input: "x", tools: Array(100001).fill(null) }, config()), { code: "invalid_parameter" });
});
test("policy preserves permitted message, logprobs, phase, raw reasoning and opaque extensions", () => {
  const p = policy(); const response = parent([message(), { type: "reasoning", id: "reason", summary: [{ type: "summary_text", text: "summary" }], content: [{ type: "reasoning_text", text: "raw" }], encrypted_content: "opaque", provider_extra: { retained: true } }, { type: "compaction", id: "compact", encrypted_content: "opaque" }]);
  const saved = structuredClone(response); assert.equal(validateNativeResponse(response, p), response); assert.deepEqual(response, saved);
});
test("policy rejects unrequested functions and specialized items even nested beside valid messages", () => {
  for (const type of ["web_search_call", "file_search_call", "image_generation_call", "code_interpreter_call", "mcp_call", "mcp_approval_request", "custom_tool_call", "computer_call", "future_tool"]) {
    const p = type === "future_tool" ? policy({ tools: [tool()] }, withFunctions()) : policy(); assert.equal(inspect(p, "response.completed", { response: parent([message(), { type, id: "special" }]) }), false);
  }
  assert.equal(inspect(policy(), "response.completed", { response: parent([call()]) }), false);
  assert.equal(inspect(policy({ tools: [tool()], tool_choice: "none" }, withFunctions()), "response.output_item.added", { item: call(), output_index: 0 }), false);
});
test("policy correlates permitted item_id rather than call_id and checks forced names and renamed calls", () => {
  const p = policy({ tools: [tool(), tool("other")], tool_choice: { type: "function", name: "lookup" } }, config({ nativePolicies: { local: { features: [], customToolNames: ["lookup", "other"] } } }));
  assert.equal(inspect(p, "response.output_item.added", { item: call({ arguments: "" }), output_index: 2 }), true);
  assert.equal(inspect(p, "response.function_call_arguments.delta", { item_id: "item-1", output_index: 2, delta: "{" }), true);
  assert.equal(inspect(p, "response.function_call_arguments.delta", { item_id: "call-1", output_index: 2, delta: "{" }), false);
  assert.equal(inspect(p, "response.function_call_arguments.done", { item_id: "item-1", output_index: 2, name: "other", arguments: "{}" }), false);
  assert.equal(inspect(p, "response.output_item.done", { item: call({ name: "other" }), output_index: 2 }), false);
  assert.equal(inspect(policy({ tools: [tool()] }, withFunctions()), "response.function_call_arguments.delta", { item_id: "unknown", output_index: 0, delta: "{" }), false);
});
test("policy IDs have separate namespaces and snapshots do not repeatedly consume tracking budgets", () => {
  const p = policy({ tools: [tool(), tool("other")] }, config({ limits: { sseBufferBytes: 2048 }, nativePolicies: { local: { features: [], customToolNames: ["lookup", "other"] } } }));
  const a = call({ id: "item-a", call_id: "item-b" }), b = call({ id: "item-b", call_id: "call-b", name: "other" });
  assert.equal(inspect(p, "response.output_item.added", { item: a, output_index: 0 }), true); assert.equal(inspect(p, "response.output_item.added", { item: b, output_index: 1 }), true);
  for (let i = 0; i < 5000; i++) assert.equal(inspect(p, "response.in_progress", { response: parent([a, b], { status: "in_progress" }) }), true);
  assert.equal(inspect(p, "response.function_call_arguments.done", { item_id: "item-b", output_index: 1, name: "other", arguments: "{}" }), true);
  assert.equal(inspect(p, "response.completed", { response: parent([a, a]) }), false);
});
test("policy count/byte bounds and future feature-prefix checks remain default deny", () => {
  const req = validateNativeRequest({ input: "x", tools: [tool()] }, withFunctions());
  const limited = createNativeResponsePolicy({ ...req, permissions: { ...req.permissions, maxItems: 1 } });
  assert.equal(inspect(limited, "response.output_item.added", { item: call(), output_index: 0 }), true);
  assert.equal(inspect(limited, "response.output_item.added", { item: call({ id: "other", call_id: "other" }), output_index: 1 }), false);
  const small = policy({ tools: [tool()] }, config({ limits: { sseBufferBytes: 128 }, nativePolicies: { local: { features: [], customToolNames: ["lookup"] } } })); assert.equal(inspect(small, "response.output_item.added", { item: call(), output_index: 0 }), false);
  for (const name of ["response.audio.future", "response.mcp_future", "response.web_search_call.future"]) assert.equal(policy()({ name, known: false, category: "unknown" }, { type: name }), false);
  assert.equal(policy()({ name: "future.metrics", known: false }, { type: "future.metrics", opaque: [1] }), true);
});
test("foreground JSON requires a terminal native outcome, validates known fields and does not map to Chat", () => {
  for (const status of ["completed", "failed", "incomplete", "cancelled"]) assert.equal(validateNativeResponse(parent([], { status, error: null, incomplete_details: null }), policy()).status, status);
  for (const change of [{ status: "queued" }, { status: "in_progress" }, { status: "other" }, { output: {} }, { id: null }, { object: "chat.completion" }, { usage: [] }, { incomplete_details: "bad" }]) assert.throws(() => validateNativeResponse(parent([], change), policy()), { code: "invalid_native_response" });
  assert.throws(() => validateNativeResponse(parent([call()]), policy()), { code: "native_policy_rejected" });
});
test("native JSON error redaction targets only known message text without mutating the original", () => {
  const secret = "fixture-secret-marker"; const p = parent([], { status: "failed", error: { message: `failure ${secret}` }, opaque: { data: secret } });
  const got = redactNativeResponse(p, [secret]); assert.equal(got.error.message, "failure [redacted]"); assert.equal(got.opaque.data, secret); assert.equal(p.error.message, `failure ${secret}`); assert.equal(got.model, "provider-model");
});
test("provider collections documented as nullable are accepted when explicit null", () => {
  const nulls = policy();
  assert.equal(inspect(nulls, "response.completed", { response: parent([{ type: "reasoning", id: "rs_1", summary: null }]) }), true);
  assert.equal(inspect(nulls, "response.completed", { response: parent([{ type: "reasoning", id: "rs_1", summary: [], content: null }]) }), true);
  assert.equal(inspect(nulls, "response.completed", { response: parent([{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: null }] }]) }), true);
  assert.equal(inspect(nulls, "response.completed", { response: parent([{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: [], logprobs: null }] }]) }), true);
  // A message body is not nullable: an assistant message must carry a content array.
  assert.equal(inspect(nulls, "response.completed", { response: parent([{ type: "message", id: "m", role: "assistant", content: null }]) }), false);
  // A non-null but wrong-typed collection is still rejected.
  assert.equal(inspect(nulls, "response.completed", { response: parent([{ type: "message", id: "m", role: "assistant", content: [{ type: "output_text", text: "hi", annotations: {} }] }]) }), false);
  assert.equal(inspect(nulls, "response.completed", { response: parent([{ type: "reasoning", id: "rs_1", summary: "none" }]) }), false);
});
