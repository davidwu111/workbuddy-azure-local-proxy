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
test("inert deferred defaults are accepted and dropped while every non-default value stays unsupported", () => {
  const inert = { metadata: {}, include: [], truncation: "disabled", top_logprobs: 0, service_tier: "auto", temperature: 1, top_p: 1 };
  const r = validateNativeRequest({ input: "x", ...inert }, config());
  for (const key of Object.keys(inert)) assert.equal(Object.hasOwn(r.payload, key), false);
  const rejected = [["metadata", []], ["metadata", { tenant: "a" }], ["include", {}], ["include", ["file_search_call.results"]], ["truncation", "auto"], ["top_logprobs", 1], ["service_tier", "flex"], ["temperature", 0.5], ["top_p", 0.9]];
  for (const [key, value] of rejected) assert.throws(() => validateNativeRequest({ input: "x", [key]: value }, config()), { code: "unsupported_parameter", param: key }, `${key}=${JSON.stringify(value)}`);
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
  for (const key of ["previous_response_id", "conversation", "agent_reference", "agent_session_id", "context_management", "include", "prompt", "metadata", "routing_config", "stream_options"]) assert.throws(() => validateNativeRequest({ input: "x", [key]: null }, config()), { code: "unsupported_parameter", param: key });
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
  const native = config({ nativePolicies: { local: { features: ["custom-tool", "web-search", "file-search", "code-interpreter", "image-generation", "mcp", "image-input", "file-input"], customToolNames: ["lookup", "grammar"], vectorStoreIds: ["vs_1"], containerIds: ["ctr_1", "auto"], fileIds: ["file_1"], mediaUrls: ["https://media.example/image.png"], imageModels: ["gpt-image-1"], mcpServers: [{ label: "tools", url: "https://mcp.example/api", toolNames: ["search"] }] } } });
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
  const tools = [{ type: "image_generation", model: "gpt-image-1" }];
  assert.throws(() => validateNativeRequest({ input: "x", stream: true, tools }, config({ nativePolicies: { local: base } })), { code: "unsupported_parameter", param: "stream" });
  assert.throws(() => validateNativeRequest({ input: "x", tools: [{ type: "image_generation", partial_images: 2 }] }, config({ nativePolicies: { local: base } })), { code: "unsupported_parameter" });
  const verified = config({ nativePolicies: { local: { ...base, verifiedCapabilities: ["image-generation-streaming"] } } });
  assert.ok(validateNativeRequest({ input: "x", stream: true, tools }, verified));
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
