"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { BridgeError, toResponsesRequest, extractResponse, terminalOutcome, mapUsage, ignoredClientFields } = require("./adapter");
const { normalizeChatDefaults } = require("./chat-contract");

// Synthetic objects only: no bridge entrypoint, environment files, listeners, or credentials.
function configuration(overrides = {}) {
  const profile = {
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    samplingEfforts: ["none"], maxOutputTokens: 128000, images: false,
    verbosity: true, cacheBreakpoints: true, reasoningModes: ["standard", "pro"],
    reasoningContexts: ["auto", "current_turn", "all_turns"], deploymentType: "payg",
    ...(overrides.profile || {}),
  };
  return {
    defaultModel: "local-luna", models: { "local-luna": { deployment: "deployment-renamed", variant: "gpt-6-luna", version: "synthetic-version", profile } },
    maxOutputTokens: 64000, defaults: { store: false }, instructionPolicy: "preserve",
    allowStore: false, samplingPolicy: "reject", ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "profile")),
  };
}
const request = (extras = {}) => ({ messages: [{ role: "user", content: "hello" }], ...extras });
const convert = (body = request(), config = configuration()) => toResponsesRequest(body, config);
function rejected(body, param, config = configuration()) {
  assert.throws(() => convert(body, config), (error) => error instanceof BridgeError && error.status === 400 && (!param || error.param === param));
}
const call = (extras = {}) => ({ type: "function_call", status: "completed", call_id: "call_1", name: "lookup", arguments: '{"key":"a"}', ...extras });
const response = (extras = {}) => ({ id: "resp_synthetic", created_at: 123, model: "secret-deployment-name", status: "completed", output: [], ...extras });
const historyCall = (id = "call_1", args = '{"key":"a"}') => ({ id, type: "function", function: { name: "lookup", arguments: args } });
const tool = (strict, schema = { type: "object", properties: { optional: { type: "string" } } }) => ({ type: "function", function: { name: "lookup", parameters: schema, ...(strict !== undefined ? { strict } : {}) } });

function frozen(value) {
  if (value && typeof value === "object") { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

test("pure adapter returns deterministic payload with deployment routing and explicit privacy/budget defaults", () => {
  const body = frozen(request());
  const config = frozen(configuration());
  const payload = convert(body, config);
  assert.deepEqual(payload, { model: "deployment-renamed", input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], stream: false, max_output_tokens: 64000, store: false });
  assert.deepEqual(convert(body, config), payload);
  assert.equal(payload.reasoning, undefined);
});

test("only exact configured aliases route; omission defaults but malformed model fails closed", () => {
  assert.equal(convert(request({ model: "local-luna" })).model, "deployment-renamed");
  for (const model of [null, "", 1, "deployment-renamed", "gpt-6-luna", "constructor", "toString", "__proto__"]) rejected(request({ model }), "model");
  const config = configuration();
  config.models.alt = { ...config.models["local-luna"], deployment: "other-deployment" };
  assert.equal(convert(request({ model: "alt" }), config).model, "other-deployment");
});

test("all supported reasoning efforts, including explicit none, are preserved", () => {
  for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(convert(request({ reasoning_effort: effort })).reasoning.effort, effort);
  }
  assert.equal(convert().reasoning, undefined);
  for (const effort of ["minimal", "ultra", "", 2]) rejected(request({ reasoning_effort: effort }), "reasoning_effort");
  rejected(request({ reasoning_effort: "none" }), "reasoning_effort", configuration({ profile: { efforts: ["low", "medium", "high", "xhigh", "max"] } }));
});

test("configured default effort is explicit and request overrides it without a hidden replacement", () => {
  const config = configuration({ defaults: { reasoningEffort: "high", reasoningMode: "standard", reasoningContext: "current_turn" } });
  assert.deepEqual(convert(request(), config).reasoning, { effort: "high", mode: "standard", context: "current_turn", summary: "auto" });
  assert.equal(convert(request({ reasoning_effort: "none" }), config).reasoning.effort, "none");
  assert.equal(convert(request(), configuration({ profile: { defaultEffort: "low" } })).reasoning.effort, "low");
});

test("mode/context controls are explicit validated fields, not uncontrolled opaque state", () => {
  for (const mode of ["standard", "pro"]) assert.equal(convert(request({ reasoning_mode: mode })).reasoning.mode, mode);
  for (const context of ["auto", "current_turn", "all_turns"]) assert.equal(convert(request({ reasoning_context: context })).reasoning.context, context);
  rejected(request({ reasoning_mode: "fast" }), "reasoning_mode");
  rejected(request({ reasoning_context: "session" }), "reasoning_context");
  rejected(request({ reasoning_mode: "pro" }), "reasoning_mode", configuration({ profile: { reasoningModes: ["standard"] } }));
});

test("sampling is gated by effective effort and ranges", () => {
  const payload = convert(request({ reasoning_effort: "none", temperature: 0.2, top_p: 0.9 }));
  assert.equal(payload.temperature, 0.2); assert.equal(payload.top_p, 0.9);
  for (const effort of [undefined, "low", "medium", "high", "xhigh", "max"]) {
    const extras = effort ? { reasoning_effort: effort } : {};
    for (const key of ["temperature", "top_p"]) rejected(request({ ...extras, [key]: 1 }), key);
  }
  for (const [key, values] of [["temperature", [-1, 2.1, NaN, Infinity, "1"]], ["top_p", [-1, 1.1, NaN, Infinity, "1"]]]) {
    for (const value of values) rejected(request({ reasoning_effort: "none", [key]: value }), key);
  }
  assert.equal(convert(request({ temperature: 0.5 }), configuration({ profile: { defaultEffort: "none" } })).temperature, 0.5);
});

test("drop-defaults never drops nondefault or invalid sampling values", () => {
  const config = configuration({ samplingPolicy: "drop-defaults" });
  const result = convert(request({ reasoning_effort: "high", temperature: 1, top_p: 1 }), config);
  assert.equal(result.temperature, undefined); assert.equal(result.top_p, undefined);
  rejected(request({ reasoning_effort: "high", temperature: 0.99 }), "temperature", config);
  rejected(request({ reasoning_effort: "high", top_p: "1" }), "top_p", config);
  assert.equal(convert(request({ reasoning_effort: "none", temperature: 1 }), config).temperature, 1);
});

test("budget fields are individually validated, max_completion takes precedence, configured maximum always applied", () => {
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    for (const value of [0, -1, "5", 1.5, NaN, Infinity, 64001]) rejected(request({ [key]: value }));
    assert.equal(convert(request({ [key]: 123 })).max_output_tokens, 123);
  }
  assert.equal(convert(request({ max_tokens: 123, max_completion_tokens: 123 })).max_output_tokens, 123);
  assert.equal(convert(request({ max_tokens: 100, max_completion_tokens: 200 })).max_output_tokens, 200);
  rejected(request({ max_tokens: 64001, max_completion_tokens: 200 }), "max_tokens");
  rejected(request({ max_tokens: "bad", max_completion_tokens: 200 }), "max_tokens");
  assert.equal(convert(request(), configuration({ profile: { maxOutputTokens: 1000 } })).max_output_tokens, 1000);
});

test("omitted output budget uses the configured default while explicit budgets keep the ceiling", () => {
  const config = configuration({ maxOutputTokens: 128000, defaultMaxOutputTokens: 4096 });
  assert.equal(convert(request(), config).max_output_tokens, 4096);
  assert.equal(convert(request({ max_tokens: 8192 }), config).max_output_tokens, 8192);
  assert.equal(convert(request({ max_completion_tokens: 8192 }), config).max_output_tokens, 8192);
  rejected(request({ max_tokens: 128001 }), "max_tokens", config);
  rejected(request({ max_completion_tokens: 128001 }), "max_completion_tokens", config);
  // A default above the effective deployment cap never raises the ceiling.
  assert.equal(convert(request(), configuration({ maxOutputTokens: 128000, defaultMaxOutputTokens: 4096, profile: { maxOutputTokens: 1000 } })).max_output_tokens, 1000);
});

test("WorkBuddy boolean boundary hints are ignored without changing message authority or request semantics", () => {
  const original = { messages: [
    { role: "system", content: "stable" }, { role: "developer", content: "instruction" },
    { role: "user", content: "question" }, { role: "assistant", content: "answer" },
    { role: "user", content: "follow-up" },
  ] };
  const expected = convert(frozen(structuredClone(original)));
  for (const value of [true, false]) {
    const marked = frozen({ messages: original.messages.map(message => ({ ...message, startsNewUserRequest: value })) });
    assert.deepEqual(convert(marked), expected);
    assert.ok(marked.messages.every(message => message.startsNewUserRequest === value));
    assert.equal(JSON.stringify(convert(marked)).includes("startsNewUserRequest"), false);
  }
  rejected({ messages: original.messages.map(message => ({ ...message, startsNewUserRequest: true })) }, "messages[1].role", configuration({ instructionPolicy: "reject-mixed" }));
});

test("WorkBuddy boundary metadata accepts booleans only and does not allow unrelated or misplaced fields", () => {
  for (const value of [null, undefined, 0, 1, "true", "false", {}, []]) {
    rejected(request({ messages: [{ role: "user", content: "fixture", startsNewUserRequest: value }] }), "messages[0].startsNewUserRequest");
  }
  rejected(request({ startsNewUserRequest: true }), "body.startsNewUserRequest");
  rejected(request({ messages: [{ role: "user", content: "fixture", startsNewUserRequest: true, unknownControl: true }] }), "messages[0].unknownControl");
  rejected(request({ messages: [{ role: "user", content: [{ type: "text", text: "fixture", startsNewUserRequest: true }] }] }), "messages[0].content[0].startsNewUserRequest");
});

test("WorkBuddy boundary hints do not alter or bypass function call/result association", () => {
  const original = { messages: [
    { role: "user", content: "fixture" },
    { role: "assistant", content: null, tool_calls: [historyCall("call_1")] },
    { role: "tool", tool_call_id: "call_1", content: [{ type: "text", text: "result" }] },
    { role: "user", content: "continue" },
  ] };
  const marked = { messages: original.messages.map((message, index) => ({ ...message, startsNewUserRequest: index === 0 || index === 3 })) };
  assert.deepEqual(convert(marked), convert(original));
  marked.messages[2].tool_call_id = "orphan";
  rejected(marked, "messages[2].tool_call_id");
});

test("standard nullable unset controls and disabled defaults retain a finite bridge budget", () => {
  const extras = { stream: null, stream_options: null, n: null, max_tokens: null, max_completion_tokens: null,
    temperature: null, top_p: null, reasoning_effort: null, verbosity: null, metadata: null, store: null,
    audio: null, modalities: null, moderation: null, prediction: null, seed: null, service_tier: null,
    frequency_penalty: null, presence_penalty: null, logit_bias: null, logprobs: null, top_logprobs: null,
    prompt_cache_retention: null, safety_identifier: null };
  assert.deepEqual(convert(frozen(request(extras))), convert(request()));
  assert.equal(convert(request({ max_tokens: 100, max_completion_tokens: null })).max_output_tokens, 100);
  assert.equal(convert(request({ max_tokens: null, max_completion_tokens: 200 })).max_output_tokens, 200);
  const disabled = request({ frequency_penalty: 0, presence_penalty: 0, logit_bias: {}, logprobs: false, stop: [], modalities: ["text"] });
  assert.deepEqual(convert(frozen(disabled)), convert(request()));
  const configured = configuration({ defaults: { reasoningEffort: "high", cacheKey: "fixture-prefix", store: false } });
  const mapped = convert(request({ reasoning_effort: null, prompt_cache_key: null, store: null }), configured);
  assert.equal(mapped.reasoning.effort, "high"); assert.equal(mapped.prompt_cache_key, undefined); assert.equal(mapped.store, false);
});

test("exact inert service, moderation and logprob defaults are dropped before conversion", () => {
  const baseline = convert(request());
  for (const [extras, normalized] of [
    [{ service_tier: "auto" }, ["service_tier"]],
    [{ moderation: "auto" }, ["moderation"]],
    [{ logprobs: false, top_logprobs: 0 }, ["logprobs", "top_logprobs"]],
  ]) {
    const body = request(extras);
    const payload = convert(body);
    assert.deepEqual(payload, baseline);
    const serialized = JSON.stringify(payload);
    for (const field of normalized) assert.equal(serialized.includes(field), false);
    assert.deepEqual(normalizeChatDefaults(body).normalizedFields, normalized);
  }
  // Non-default values keep exactly their existing error class and parameter.
  assert.throws(() => convert(request({ service_tier: "priority" })), error => error.code === "unsupported_parameter" && error.param === "body.service_tier");
  assert.throws(() => convert(request({ moderation: { mode: "strict" } })), error => error.code === "unsupported_parameter" && error.param === "body.moderation");
  assert.throws(() => convert(request({ logprobs: true })), error => error.code === "unsupported_parameter" && error.param === "body.logprobs");
  assert.throws(() => convert(request({ top_logprobs: 5 })), error => error.code === "invalid_parameter" && error.param === "top_logprobs");
  assert.throws(() => convert(request({ logprobs: false, top_logprobs: 5 })), error => error.code === "invalid_parameter" && error.param === "top_logprobs");
  // Sampling compatibility stays owned by BRIDGE_SAMPLING_POLICY, not normalization.
  assert.throws(() => convert(request({ temperature: 1 })), error => error.code === "invalid_parameter" && error.param === "temperature");
  assert.equal(normalizeChatDefaults({ temperature: 1, top_p: 1 }).body.temperature, 1);
});

test("nonnullable standard options and malformed defaults are not coerced into harmless values", () => {
  for (const field of ["tools", "tool_choice", "parallel_tool_calls", "prompt_cache_options", "response_format", "user", "web_search_options", "functions", "function_call"]) {
    assert.throws(() => convert(request({ [field]: null })), error => error.code === "invalid_parameter" && error.param === field);
  }
  for (const extras of [{ frequency_penalty: "0" }, { presence_penalty: false }, { logprobs: "false" }, { logit_bias: [] }, { modalities: [] }, { seed: "1" }, { stop: [1] }]) rejected(request(extras));
  rejected(request({ max_tokens: 0, max_completion_tokens: null }), "max_tokens");
});

test("standard unsupported semantic fields differ from unknown request fields", () => {
  for (const [field, value] of [["frequency_penalty", 1], ["presence_penalty", -1], ["logit_bias", { "10": 2 }], ["logprobs", true], ["stop", ["END"]], ["seed", 1], ["modalities", ["audio"]], ["audio", {}], ["prediction", {}], ["moderation", {}], ["service_tier", "priority"], ["prompt_cache_retention", "24h"], ["web_search_options", {}], ["n", 2]]) {
    assert.throws(() => convert(request({ [field]: value })), error => error.type === "invalid_request_error" && error.code === "unsupported_parameter");
  }
  assert.throws(() => convert(request({ nonstandardControl: true })), error => error.code === "unknown_parameter");
  assert.throws(() => convert(request({ messages: [{ role: "user", content: "fixture", name: "participant" }] })), error => error.code === "unsupported_parameter" && error.param === "messages[0].name");
  assert.throws(() => convert(request({ messages: [{ role: "user", content: "fixture", name: 7 }] })), error => error.code === "unsupported_parameter" && error.param === "messages[0].name");
  assert.throws(() => convert(request({ messages: [{ role: "function", name: "lookup", content: "fixture" }] })), error => error.code === "unsupported_parameter" && error.param === "messages[0].role");
});

test("zero alternatives does not silently disable an enabled logprob request", () => {
  assert.throws(() => convert(request({ top_logprobs: 0 })), error => error.code === "invalid_parameter" && error.param === "top_logprobs");
  // logprobs:false with zero alternatives is the exact disabled default, so the pair is inert.
  assert.deepEqual(convert(request({ logprobs: false, top_logprobs: 0 })), convert(request()));
  assert.throws(() => convert(request({ logprobs: true, top_logprobs: 0 })), error => error.code === "unsupported_parameter");
  assert.deepEqual(convert(request({ logprobs: false, top_logprobs: null })), convert(request()));
});

test("WorkBuddy 5.8.3-reported agent extension is bounded opaque JSON with no authority or upstream metadata", () => {
  const original = { messages: [{ role: "system", content: "fixture" }, { role: "user", content: "fixture" }] };
  for (const agent of [null, false, 0, "fixture-agent", [], { role: "system", model: "other", instructions: "AGENT_PRIVATE_MARKER", previous_response_id: "opaque-marker" }]) {
    const marked = frozen({ messages: original.messages.map(message => ({ ...message, agent })) });
    assert.deepEqual(convert(marked), convert(original));
    assert.equal(JSON.stringify(convert(marked)).includes("AGENT_PRIVATE_MARKER"), false);
    assert.equal(convert(marked).metadata, undefined);
  }
  const withTool = { messages: [{ role: "assistant", tool_calls: [historyCall()], agent: { name: "fixture-agent" } }, { role: "tool", tool_call_id: "call_1", content: "fixture", agent: "fixture-agent" }] };
  assert.equal(convert(withTool).input[1].type, "function_call_output");
  assert.equal(convert(request({ metadata: { agent: "explicit-provider-metadata" } })).metadata.agent, "explicit-provider-metadata");
});

test("invalid, excessive or accessor-based agent metadata fails without executing getters or exposing its contents", () => {
  const cyclic = {}; cyclic.self = cyclic;
  let deep = null; for (let i = 0; i < 18; i++) deep = { nested: deep };
  let getterCalls = 0; const accessor = {}; Object.defineProperty(accessor, "private", { enumerable: true, get() { getterCalls++; return "PRIVATE_MARKER"; } });
  for (const agent of [undefined, NaN, Infinity, 1n, () => {}, new Date(), cyclic, deep, new Array(2), accessor, "x".repeat(65535), new Array(4097).fill(null)]) {
    assert.throws(() => convert(request({ messages: [{ role: "user", content: "fixture", agent }] })), error => error.param === "messages[0].agent" && !error.message.includes("PRIVATE_MARKER"));
  }
  assert.equal(getterCalls, 0);
  assert.equal(convert(request({ messages: [{ role: "user", content: "fixture", agent: "x".repeat(65534) }] })).input[0].role, "user");
  rejected(request({ agent: {} }), "body.agent");
});

test("standard assistant omission, nullable strictness and no-tools controls are handled without rewriting semantics", () => {
  const input = { messages: [{ role: "assistant", tool_calls: [historyCall()] }, { role: "tool", tool_call_id: "call_1", content: "result" }] };
  assert.equal(convert(input).input[0].type, "function_call");
  assert.equal(convert(request({ tool_choice: "auto", parallel_tool_calls: true })).tool_choice, "none");
  assert.equal(convert(request({ parallel_tool_calls: false })).parallel_tool_calls, undefined);
  const definition = tool(null); const mappedTool = convert(request({ tools: [definition] })).tools[0];
  assert.equal(mappedTool.strict, false); assert.deepEqual(mappedTool.parameters, definition.function.parameters);
  const format = { type: "json_schema", json_schema: { name: "fixture", strict: null, schema: { type: "object" } } };
  assert.equal(convert(request({ response_format: format })).text.format.strict, false);
  assert.equal(convert(request({ safety_identifier: "fixture-user" })).safety_identifier, "fixture-user");
  rejected(request({ safety_identifier: "x".repeat(129) }), "safety_identifier");
  assert.throws(() => convert(request({ tools: [{ type: "custom", custom: { name: "fixture" } }] })), error => error.code === "unsupported_parameter");
  assert.throws(() => convert(request({ stream: true, stream_options: { include_obfuscation: true } })), error => error.code === "unsupported_parameter");
});

test("WorkBuddy conversationRequestId and configurable client metadata stay bounded and ignored", () => {
  const original = { messages: [{ role: "system", content: "fixture" }, { role: "user", content: "fixture" }] };
  for (const id of ["01a15d280d6e74e892b1c238401a9faa", "", null, 0, false, { turn: 1 }, [], "x".repeat(200)]) {
    const marked = frozen({ messages: original.messages.map(message => ({ ...message, conversationRequestId: id })) });
    assert.deepEqual(convert(marked), convert(original));
    assert.equal(JSON.stringify(convert(marked)).includes("conversationRequestId"), false);
    assert.equal(convert(marked).metadata, undefined);
  }
  // An operator may extend the ignored-metadata set by configuration, but the
  // extension can never claim a reserved or standard message field.
  const extended = configuration({ clientMetadataFields: ["agent", "conversationRequestId", "clientTraceNonce"] });
  const body = { messages: [{ role: "user", content: "fixture", agent: { a: 1 }, conversationRequestId: "fixture-id", clientTraceNonce: "fixture-nonce" }] };
  assert.deepEqual(convert(body, extended), convert({ messages: [{ role: "user", content: "fixture" }] }, extended));
  rejected({ messages: [{ role: "user", content: "fixture", otherNonce: "x" }] }, "messages[0].otherNonce", extended);
  // Omitting the field from the list rejects it again rather than silently ignoring it.
  const narrowed = configuration({ clientMetadataFields: ["startsNewUserRequest"] });
  rejected({ messages: [{ role: "user", content: "fixture", agent: {} }] }, "messages[0].agent", narrowed);
});

test("auto metadata mode absorbs unknown message annotations but never semantics", () => {
  const auto = configuration({ clientMetadataMode: "auto" });
  const strict = configuration({ clientMetadataMode: "strict" });
  const annotated = { messages: [
    { role: "user", content: "fixture", toolCallIndex: 0, providerTrace: { id: "fixture" } },
    { role: "assistant", content: null, tool_calls: [historyCall()], turnToken: "fixture", phaseState: "fixture" },
    { role: "tool", tool_call_id: "call_1", content: "result", isError: false, toolName: "lookup" },
  ] };
  const expected = convert({ messages: [
    { role: "user", content: "fixture" },
    { role: "assistant", content: null, tool_calls: [historyCall()] },
    { role: "tool", tool_call_id: "call_1", content: "result" },
  ] }, auto);
  assert.deepEqual(convert(frozen(structuredClone(annotated)), auto), expected);
  assert.equal(JSON.stringify(convert(annotated, auto)).includes("fixture"), true); // prompt text only
  assert.equal(JSON.stringify(convert(annotated, auto)).includes("providerTrace"), false);
  rejected(annotated, "messages[0].toolCallIndex", strict);
  // Reserved/standard message fields are still rejected in auto mode.
  rejected({ messages: [{ role: "user", content: "fixture", name: "participant" }] }, "messages[0].name", auto);
  rejected({ messages: [{ role: "tool", content: "result", tool_call_id: "call_1", audio: {} }] }, "messages[0].audio", auto);
  // Malformed metadata still fails rather than being silently accepted.
  let deep = null; for (let i = 0; i < 18; i++) deep = { nested: deep };
  rejected({ messages: [{ role: "user", content: "fixture", extra: deep }] }, "messages[0].extra", auto);
  // Top-level unknown fields are never absorbed by message metadata mode.
  rejected(request({ unknownTopLevel: true }), "body.unknownTopLevel", auto);
});

test("ignored client field names are reported without values", () => {
  const auto = configuration({ clientMetadataMode: "auto" });
  const names = ignoredClientFields({ messages: [
    { role: "user", content: "PRIVATE_MARKER", turnToken: "PRIVATE_MARKER", agent: { a: "PRIVATE_MARKER" } },
    { role: "tool", tool_call_id: "call_1", content: "x", isError: false },
  ] }, auto);
  assert.deepEqual(names, ["messages.agent", "messages.isError", "messages.turnToken"]);
  assert.equal(JSON.stringify(names).includes("PRIVATE_MARKER"), false);
  assert.deepEqual(ignoredClientFields(null, auto), []);
  assert.deepEqual(ignoredClientFields({ messages: "x" }, auto), []);
});

test("namespaced array-valued message metadata (sub-agent shape) is absorbed in auto mode", () => {
  // Reproduces the observed rejection: messages[10] carried an unknown key with
  // an array value, which the plain-identifier rule refused to absorb.
  const auto = configuration({ clientMetadataMode: "auto" });
  const annotations = { "wb.subagent.children": [{ id: "a" }, { id: "b" }], "workbuddy:step": [1, 2, 3], "x-trace": ["t"] };
  const messages = Array.from({ length: 11 }, (_, index) => ({ role: "user", content: `fixture-${index}` }));
  messages[10] = { ...messages[10], ...annotations };
  const expected = convert({ messages }, auto);
  const actual = convert(frozen(structuredClone({ messages })), auto);
  assert.deepEqual(actual, expected);
  const serialized = JSON.stringify(actual);
  for (const key of Object.keys(annotations)) assert.equal(serialized.includes(key), false);
  // Client keys may use unusual characters; only length is bounded.
  const odd = { "$ref": ["a"], "@type": ["b"], "key with space": ["c"], "has\nnewline": ["d"] };
  const oddMessages = [...messages.slice(0, 10), { ...messages[10], ...odd }];
  const oddMapped = convert({ messages: oddMessages }, auto);
  for (const key of Object.keys(odd)) assert.equal(JSON.stringify(oddMapped).includes(JSON.stringify(key).slice(1, -1)), false);
  rejected({ messages: [...messages.slice(0, 10), { ...messages[10], ["x".repeat(129)]: [] }] }, undefined, auto);
  rejected({ messages: [{ role: "user", content: "fixture", "wb.name": ["x"] }] }, "messages[0].wb.name", configuration({ clientMetadataMode: "strict" }));
  assert.deepEqual(ignoredClientFields({ messages }, auto), ["messages.wb.subagent.children", "messages.workbuddy:step", "messages.x-trace"]);
});

test("echoed citation annotations on assistant history are accepted and never forwarded", () => {
  // The bridge emits annotations as a Chat extension; clients replay them inside
  // the assistant content block, which previously failed as an unknown field.
  const citations = [{ type: "url_citation", url: "https://example.invalid/a", start_index: 0, end_index: 3 }];
  const body = { messages: [
    { role: "user", content: "fixture" },
    { role: "assistant", content: [{ type: "text", text: "answer", annotations: citations }], annotations: citations },
    { role: "user", content: "continue" },
  ] };
  const payload = convert(frozen(structuredClone(body)));
  const serialized = JSON.stringify(payload);
  assert.equal(serialized.includes("annotations"), false);
  assert.equal(serialized.includes("url_citation"), false);
  assert.deepEqual(payload.input[1], { role: "assistant", content: [{ type: "output_text", text: "answer" }] });
  // Bounded metadata: non-JSON or oversized annotation values still fail.
  rejected({ messages: [{ role: "assistant", content: [{ type: "text", text: "x", annotations: () => {} }] }] }, undefined);
  const huge = [{ type: "url_citation", url: "https://example.invalid/" + "a".repeat(70000) }];
  rejected({ messages: [{ role: "assistant", content: [{ type: "text", text: "x", annotations: huge }] }] }, "messages[0].content[0].annotations");
});

test("malformed or unsupported semantic requests are rejected, never silently filtered", () => {
  for (const body of [null, [], {}, request({ messages: [] }), request({ messages: [null] }), request({ messages: [{ role: "alien", content: "x" }] }), request({ messages: [{ role: "user", content: {} }] }), request({ messages: [{ role: "user", content: [] }] })]) rejected(body);
  for (const [key, value] of [["stop", ["END"]], ["functions", []], ["function_call", "auto"], ["logprobs", true], ["top_logprobs", 0], ["frequency_penalty", 1], ["presence_penalty", 1], ["seed", 1], ["previous_response_id", "resp_other"], ["conversation", "conversation_1"], ["include", ["reasoning.encrypted_content"]], ["reasoning", {}], ["prompt_cache_retention", "24h"], ["unknown_control", true]]) rejected(request({ [key]: value }));
  rejected(request({ n: 2 }), "n"); rejected(request({ n: "1" }), "n"); assert.equal(convert(request({ n: 1 })).n, undefined);
  rejected(request({ stream: "true" }), "stream");
  rejected(request({ tools: [{ type: "web_search" }] }));
  rejected(request({ messages: [{ role: "user", content: "x", name: "Bob" }] }));
});

test("stream opt-in is validated locally but not leaked as unsupported Responses fields", () => {
  const payload = convert(request({ stream: true, stream_options: { include_usage: true } }));
  assert.equal(payload.stream, true); assert.equal(payload.stream_options, undefined);
  rejected(request({ stream_options: { include_usage: true } }), "stream_options");
  rejected(request({ stream: true, stream_options: { include_usage: 1 } }), "stream_options.include_usage");
  rejected(request({ stream: true, stream_options: { other: true } }), "stream_options.other");
});

test("instructions keep original chronology and content boundaries; append keeps prefix identical", () => {
  const body = { messages: [
    { role: "system", content: [{ type: "text", text: "base" }, { type: "text", text: "boundary" }] },
    { role: "user", content: "old" }, { role: "assistant", content: "reply" },
    { role: "developer", content: "late instruction" },
  ] };
  const first = convert(body);
  assert.deepEqual(first.input.map((item) => item.role), ["system", "user", "assistant", "developer"]);
  assert.equal(first.instructions, undefined);
  assert.equal(first.input[0].content.length, 2);
  assert.equal(first.input[2].content[0].type, "output_text");
  assert.deepEqual(convert({ messages: [...body.messages, { role: "user", content: "new" }] }).input.slice(0, 4), first.input);
  for (const policy of ["developer", "system"]) {
    const input = convert(body, configuration({ instructionPolicy: policy })).input;
    assert.equal(input[0].role, policy); assert.equal(input[3].role, policy);
  }
  rejected(body, "messages[3].role", configuration({ instructionPolicy: "reject-mixed" }));
});

test("assistant summaries are not opaque reasoning replay and explicit phase is not inferred", () => {
  const body = { messages: [{ role: "assistant", content: "working", phase: "commentary", reasoning_content: "display summary" }, { role: "user", content: "continue" }] };
  const payload = convert(body);
  assert.equal(payload.input[0].phase, "commentary");
  assert.equal(JSON.stringify(payload).includes("display summary"), false);
  assert.equal(convert().input[0].phase, undefined);
  rejected({ messages: [{ role: "assistant", content: "x", phase: "final" }] }, "messages[0].phase");
});

test("image input is opt-in, user-only, keeps detail and cache breakpoint without fetching", () => {
  const body = request({ messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/image.png", detail: "low" }, prompt_cache_breakpoint: { mode: "explicit" } }] }] });
  rejected(body);
  const config = configuration({ profile: { images: true } });
  assert.deepEqual(convert(body, config).input[0].content[0], { type: "input_image", image_url: "https://example.invalid/image.png", detail: "low", prompt_cache_breakpoint: { mode: "explicit" } });
  for (const url of ["file:///secret", "https://user:pass@example.invalid/a", "javascript:alert(1)", "not a URL"]) {
    const bad = structuredClone(body); bad.messages[0].content[0].image_url.url = url; rejected(bad, "messages[0].content[0].image_url.url", config);
  }
  const data = structuredClone(body); data.messages[0].content[0].image_url.url = "data:image/png;base64,YWJj";
  assert.equal(convert(data, config).input[0].content[0].type, "input_image");
  for (const role of ["system", "developer", "assistant"]) {
    const bad = structuredClone(body); bad.messages[0].role = role; rejected(bad, undefined, config);
  }
});

test("cache defaults/overrides and all eligible instruction text blocks preserve explicit cost intent", () => {
  const config = configuration({ defaults: { cacheKey: "prefix-family", cacheOptions: { mode: "implicit", ttl: "30m" } } });
  const body = { messages: [{ role: "system", content: [{ type: "text", text: "stable", prompt_cache_breakpoint: { mode: "explicit" } }] }, { role: "user", content: "question" }] };
  const payload = convert(body, config);
  assert.equal(payload.prompt_cache_key, "prefix-family"); assert.deepEqual(payload.prompt_cache_options, { mode: "implicit", ttl: "30m" });
  assert.deepEqual(payload.input[0].content[0].prompt_cache_breakpoint, { mode: "explicit" });
  assert.equal(convert({ messages: [...body.messages, { role: "user", content: "suffix" }] }, config).prompt_cache_key, payload.prompt_cache_key);
  const explicitNoWrites = convert(request({ prompt_cache_options: { mode: "explicit", ttl: "30m" }, prompt_cache_key: "override" }), config);
  assert.deepEqual(explicitNoWrites.prompt_cache_options, { mode: "explicit", ttl: "30m" });
  assert.equal(explicitNoWrites.prompt_cache_key, "override"); assert.equal(JSON.stringify(explicitNoWrites.input).includes("breakpoint"), false);
  for (const options of [null, [], { mode: "bad" }, { mode: "implicit", ttl: "24h" }, { mode: "implicit", unknown: true }]) rejected(request({ prompt_cache_options: options }));
  rejected(request({ prompt_cache_key: "" }), "prompt_cache_key");
  rejected({ messages: [{ role: "user", content: [{ type: "text", text: "x", cache_control: { type: "ephemeral" } }] }] });
  rejected({ messages: [{ role: "assistant", content: [{ type: "text", text: "x", prompt_cache_breakpoint: { mode: "explicit" } }] }] });
});

test("PTU-M profiles reject explicit disable/write policies, not implicit keys", () => {
  const config = configuration({ profile: { deploymentType: "ptu-m", cacheBreakpoints: false } });
  rejected(request({ prompt_cache_options: { mode: "explicit" } }), "prompt_cache_options.mode", config);
  rejected({ messages: [{ role: "user", content: [{ type: "text", text: "x", prompt_cache_breakpoint: { mode: "explicit" } }] }] }, undefined, config);
  assert.equal(convert(request({ prompt_cache_options: { mode: "implicit", ttl: "30m" }, prompt_cache_key: "family" }), config).prompt_cache_key, "family");
});

test("storage stays deliberate and requires bridge-level opt-in", () => {
  assert.equal(convert().store, false); assert.equal(convert(request({ store: false })).store, false);
  rejected(request({ store: true }), "store"); rejected(request({ store: "false" }), "store");
  assert.equal(convert(request({ store: true }), configuration({ allowStore: true })).store, true);
  assert.equal(convert(request(), configuration({ allowStore: true, defaults: { store: true } })).store, true);
  assert.equal(convert(request({ store: false }), configuration({ allowStore: true, defaults: { store: true } })).store, false);
});

test("function definitions default to nonstrict and preserve explicit false/true schemas", () => {
  for (const strict of [undefined, false]) {
    const original = tool(strict);
    const payload = convert(request({ tools: [original] }));
    assert.equal(payload.tools[0].strict, false);
    assert.deepEqual(payload.tools[0].parameters, original.function.parameters);
  }
  const schema = { type: "object", additionalProperties: false, properties: { value: { type: ["string", "null"] }, nested: { type: "object", properties: {}, required: [], additionalProperties: false } }, required: ["value", "nested"] };
  assert.equal(convert(request({ tools: [tool(true, schema)] })).tools[0].strict, true);
  const bad = structuredClone(schema); bad.properties.nested.additionalProperties = true;
  rejected(request({ tools: [tool(true, bad)] }));
  const optional = structuredClone(schema); optional.required = ["value"];
  rejected(request({ tools: [tool(true, optional)] }));
  rejected(request({ tools: [tool("true")] }));
  rejected(request({ tools: [tool(false), tool(false)] }));
});

test("tool choices must reference declared function tools and shape errors never disappear", () => {
  const tools = [tool(false)];
  assert.deepEqual(convert(request({ tools, tool_choice: { type: "function", function: { name: "lookup" } }, parallel_tool_calls: false })).tool_choice, { type: "function", name: "lookup" });
  for (const value of ["auto", "required", "none"]) assert.equal(convert(request({ tools, tool_choice: value })).tool_choice, value);
  rejected(request({ tool_choice: "required" }), "tool_choice");
  rejected(request({ tools, tool_choice: { type: "function", function: { name: "undeclared" } } }), "tool_choice.function.name");
  rejected(request({ tools, tool_choice: "bogus" }), "tool_choice");
  rejected(request({ tools, parallel_tool_calls: "false" }), "parallel_tool_calls");
});

test("parallel tool round trip preserves exact call IDs and JSON arguments, tool arrays become text semantics", () => {
  const body = { messages: [
    { role: "user", content: "lookup" }, { role: "assistant", content: null, tool_calls: [historyCall("call_1"), historyCall("call_2", '{"key":"b"}')] },
    { role: "tool", tool_call_id: "call_2", content: [{ type: "text", text: "one" }, { type: "text", text: "two" }] },
    { role: "tool", tool_call_id: "call_1", content: '{"value":1}' }, { role: "user", content: "continue" },
  ] };
  const input = convert(body).input;
  assert.deepEqual(input[1], { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"key":"a"}' });
  assert.equal(input[3].output, "onetwo"); assert.equal(input[3].call_id, "call_2");
  for (const args of ['{"key":', "[]", "null", "1", {}]) {
    const bad = structuredClone(body); bad.messages[1].tool_calls[0].function.arguments = args; rejected(bad);
  }
  const missing = structuredClone(body); delete missing.messages[1].tool_calls[0].id; rejected(missing);
  const duplicate = structuredClone(body); duplicate.messages[1].tool_calls[1].id = "call_1"; rejected(duplicate);
  const orphan = structuredClone(body); orphan.messages[2].tool_call_id = "call_unknown"; rejected(orphan);
  const pending = structuredClone(body); pending.messages.splice(2); rejected(pending, "messages");
});

test("structured-output formats preserve schema identity, strictness and verbosity", () => {
  for (const type of ["text", "json_object"]) assert.deepEqual(convert(request({ response_format: { type } })).text.format, { type });
  const source = { name: "result", description: "A contract", strict: true, schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } };
  const payload = convert(request({ response_format: { type: "json_schema", json_schema: source }, verbosity: "high" }));
  assert.deepEqual(payload.text, { format: { type: "json_schema", ...source }, verbosity: "high" });
  const unstated = structuredClone(source); delete unstated.strict;
  assert.equal(convert(request({ response_format: { type: "json_schema", json_schema: unstated } })).text.format.strict, false);
  for (const format of [null, [], { type: "yaml" }, { type: "json_schema", json_schema: {} }, { type: "json_object", schema: {} }]) rejected(request({ response_format: format }));
  rejected(request({ verbosity: "max" }), "verbosity");
  rejected(request({ verbosity: "low" }), "verbosity", configuration({ profile: { verbosity: false } }));
});

test("supported metadata is copied, not aliased; unknown nested controls fail", () => {
  const body = request({ metadata: { ticket: "synthetic" }, user: "synthetic-user" });
  const payload = convert(body); payload.metadata.ticket = "changed";
  assert.equal(body.metadata.ticket, "synthetic"); assert.equal(payload.user, "synthetic-user");
  rejected(request({ metadata: { ticket: {} } }));
  const bad = request({ tools: [tool(false)] }); bad.tools[0].function.parameters.circular = bad.tools[0].function.parameters;
  rejected(bad);
});

test("completed responses expose only validated executable function calls", () => {
  const output = [call(), call({ call_id: "bad_json", arguments: '{"x":' }), call({ call_id: "array", arguments: "[]" }), call({ call_id: "in_progress", status: "in_progress" }), call({ call_id: "missing_name", name: "" }), call({ call_id: undefined, id: "item_not_call" })];
  const result = extractResponse(response({ output }), "local-luna");
  assert.equal(result.model, "local-luna"); assert.equal(result.choices[0].finish_reason, "length");
  assert.deepEqual(result.bridge_warnings, ["suppressed_invalid_or_incomplete_tool_calls"]);
  assert.deepEqual(result.choices[0].message.tool_calls, [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"key":"a"}' } }]);
  for (const unsafe of [[call(), call()], [call({ arguments: "[]" })], [call({ status: "in_progress" })]]) {
    assert.throws(() => extractResponse(response({ output: unsafe }), "local-luna"), (error) => error.status === 502 && error.code === "invalid_upstream_response");
  }
  const valid = extractResponse(response({ output: [call()] }), "local-luna");
  assert.equal(valid.choices[0].finish_reason, "tool_calls");
  const mixedMalformed = extractResponse(response({ output: [call(), call({ call_id: "bad", arguments: "[]" })] }), "local-luna");
  assert.equal(mixedMalformed.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(mixedMalformed.bridge_warnings, ["suppressed_invalid_or_incomplete_tool_calls"]);
});

test("incomplete outcomes always outrank and suppress tools, including individually completed items", () => {
  for (const [reason, finish] of [["max_output_tokens", "length"], ["content_filter", "content_filter"]]) {
    const upstream = response({ status: "incomplete", incomplete_details: { reason }, output: [call(), call({ call_id: "partial", arguments: '{"x":' })] });
    const outcome = terminalOutcome(upstream); assert.equal(outcome.successful, true); assert.equal(outcome.completed, false); assert.equal(outcome.allowToolCalls, false); assert.equal(outcome.finishReason, finish);
    const result = extractResponse(upstream, "local-luna");
    assert.equal(result.choices[0].finish_reason, finish); assert.equal(result.choices[0].message.tool_calls, undefined);
  }
});

test("material message statuses share terminal safety with function calls", () => {
  for (const itemStatus of ["in_progress", "incomplete"]) {
    const upstream = response({ output: [{ type: "message", role: "assistant", status: itemStatus, content: [{ type: "output_text", text: "partial" }] }, call()] });
    const result = extractResponse(upstream, "local-luna");
    assert.equal(result.choices[0].finish_reason, "length");
    assert.equal(result.choices[0].message.content, "partial");
    assert.equal(result.choices[0].message.tool_calls.length, 1);
  }
  const filtered = response({ output: [{ type: "message", status: "incomplete", incomplete_details: { reason: "content_filter" }, content: [{ type: "output_text", text: "partial" }] }, call()] });
  const result = extractResponse(filtered, "local-luna");
  assert.equal(result.choices[0].finish_reason, "content_filter");
  assert.equal(result.choices[0].message.tool_calls, undefined);
  assert.equal(terminalOutcome(filtered).allowToolCalls, false);
  for (const type of ["message", "function_call"]) {
    const invalid = type === "message" ? { type, status: "unknown", content: [] } : call({ status: "unknown" });
    assert.throws(() => extractResponse(response({ output: [invalid, call({ call_id: "valid" })] }), "local-luna"), (error) => error.status === 502);
  }
});

test("failed/cancelled/missing/unknown terminal outcomes cannot become normal empty completions", () => {
  for (const status of [undefined, "failed", "cancelled", "queued", "in_progress", "unknown", "incomplete"]) {
    const upstream = response({ status });
    assert.equal(terminalOutcome(upstream).ok, false);
    assert.throws(() => extractResponse(upstream, "local-luna"), (error) => error instanceof BridgeError && error.status === 502);
  }
  for (const malformed of [null, [], {}, { status: "completed" }, response({ output: {} }), response({ output: [null] }), response({ output: [{ type: "message", content: "text" }] }), response({ created_at: "now" }), response({ id: "" })]) {
    assert.throws(() => extractResponse(malformed, "local-luna"), (error) => error instanceof BridgeError && error.status === 502);
  }
  const failed = response({ status: "failed", error: { message: "Synthetic upstream error", type: "server_error", code: "offline", param: "model" } });
  assert.throws(() => extractResponse(failed, "local-luna"), (error) => error.status === 502 && error.message === "Synthetic upstream error" && error.code === "offline" && error.param === "model");
});

test("refusals remain machine-distinguishable and opaque reasoning never leaks", () => {
  const upstream = response({ output: [
    { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot comply" }] },
    { type: "reasoning", encrypted_content: "opaque-not-display", content: [{ type: "reasoning_text", text: "hidden-not-display" }], summary: [{ type: "summary_text", text: "Public summary" }] },
  ] });
  const result = extractResponse(upstream, "local-luna");
  assert.equal(result.choices[0].message.refusal, "Cannot comply"); assert.equal(result.choices[0].message.content, "Cannot comply");
  assert.equal(result.choices[0].message.reasoning_content, "Public summary");
  assert.equal(JSON.stringify(result).includes("not-display"), false);
  assert.equal(result.id, "chatcmpl-resp_synthetic"); assert.equal(result.created, 123);
});

test("safe annotations/content filters are preserved without mutating the source", () => {
  const upstream = response({ output: [{ type: "message", content: [{ type: "output_text", text: "answer", annotations: [{ type: "url_citation", url: "https://example.invalid", title: "synthetic" }] }] }], content_filters: [{ filtered: false }] });
  const result = extractResponse(frozen(upstream), "local-luna");
  assert.equal(result.choices[0].message.annotations[0].type, "url_citation");
  assert.deepEqual(result.azure_content_filters, [{ filtered: false }]);
});

test("usage preserves cache reads/writes, reasoning, zero values, raw counters and absence distinctions", () => {
  const usage = { input_tokens: 2000, output_tokens: 4, total_tokens: 2004, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 976 }, output_tokens_details: { reasoning_tokens: 0 }, provider_counter: 9 };
  const mapped = mapUsage(frozen(usage));
  assert.equal(mapped.prompt_tokens, 2000); assert.equal(mapped.completion_tokens, 4);
  assert.deepEqual(mapped.prompt_tokens_details, { cached_tokens: 0, cache_write_tokens: 976 });
  assert.deepEqual(mapped.completion_tokens_details, { reasoning_tokens: 0 });
  assert.deepEqual(mapped.azure_usage, usage); assert.notEqual(mapped.azure_usage, usage);
  const absent = mapUsage({ input_tokens: 0 });
  assert.equal(absent.prompt_tokens, 0); assert.equal(own(absent, "completion_tokens"), false); assert.equal(own(absent, "prompt_tokens_details"), false);
  assert.equal(mapUsage(undefined), undefined);
  for (const malformed of [[], "1", { input_tokens: -1 }, { output_tokens: 1.5 }, { total_tokens: "3" }, { input_tokens_details: { cached_tokens: -1 } }]) assert.throws(() => mapUsage(malformed), (error) => error.status === 502);
  const result = extractResponse(response({ usage }), "local-luna"); assert.deepEqual(result.usage, mapped);
});
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

test("cache options preserve optional mode/TTL and refuse malformed breakpoints/secret-shaped keys", () => {
  for (const options of [{}, { ttl: "30m" }, { mode: "implicit" }, { mode: "explicit" }]) {
    assert.deepEqual(convert(request({ prompt_cache_options: options })).prompt_cache_options, options);
  }
  for (const key of ["has spaces", "token=abc", "x".repeat(129), "/path"]) rejected(request({ prompt_cache_key: key }), "prompt_cache_key");
  // Null is the standard nullable "unset": it must not throw, and it must not
  // resurrect a configured bridge key either (covered by the nullable-defaults test).
  assert.equal(convert(request({ prompt_cache_key: null })).prompt_cache_key, undefined);
  for (const point of [null, {}, { mode: "implicit" }, { mode: "explicit", ttl: "30m" }]) {
    rejected({ messages: [{ role: "user", content: [{ type: "text", text: "x", prompt_cache_breakpoint: point }] }] });
  }
});

test("nonstrict schemas still validate keyword shapes and preserve unknown valid vocabulary", () => {
  for (const schema of [
    { type: "object", properties: [] }, { type: "object", required: "x" },
    { type: "object", properties: { x: { type: "text" } } },
    { type: "object", properties: { x: { type: "array", items: "bad" } } },
    { type: "object", properties: { x: { anyOf: {} } } },
  ]) rejected(request({ tools: [tool(false, schema)] }));
  const schema = { type: "object", properties: { x: { type: "string", "x-custom-keyword": { policy: "keep" } } }, "x-custom-root": 1 };
  assert.deepEqual(convert(request({ tools: [tool(false, schema)] })).tools[0].parameters, schema);
});

test("null unrelated usage counters are preserved but opaque raw fields are rejected", () => {
  const mapped = mapUsage({ input_tokens: 0, input_tokens_details: { cached_tokens: 0, audio_tokens: null }, output_tokens_details: null });
  assert.deepEqual(mapped.prompt_tokens_details, { cached_tokens: 0, audio_tokens: null });
  assert.equal(mapped.azure_usage.output_tokens_details, null);
  for (const bad of [{ input_tokens: 0, prompt: "opaque" }, { input_tokens: 0, arbitrary: true }, { input_tokens: 0, arbitrary: [] }]) {
    assert.throws(() => mapUsage(bad), (error) => error.status === 502);
  }
});

test("citation/filter sanitizers never copy arbitrary provider fields or unsafe links", () => {
  const upstream = response({ output: [{ type: "message", content: [{ type: "output_text", text: "answer", annotations: [
    { type: "url_citation", url: "https://example.invalid", title: "safe", start_index: 0, end_index: 1, opaque_reasoning: "must-not-copy" },
    { type: "file_citation", file_id: "synthetic-file", filename: "test.txt", index: 0, prompt: "must-not-copy" },
    { type: "unknown_annotation", text: "must-not-copy" },
  ] }] }], content_filters: [{ source_type: "prompt", blocked: false, content_filter_results: { hate: { filtered: false, severity: "safe", prompt: "must-not-copy" } }, opaque_reasoning: "must-not-copy" }] });
  const result = extractResponse(upstream, "local-luna");
  assert.equal(result.choices[0].message.annotations.length, 2);
  assert.equal(JSON.stringify(result).includes("must-not-copy"), false);
  assert.equal(result.azure_content_filters[0].content_filter_results.hate.severity, "safe");
  for (const url of ["javascript:alert(1)", "file:///secret", "https://user:pass@example.invalid"]) {
    const bad = structuredClone(upstream); bad.output[0].content[0].annotations[0].url = url;
    assert.throws(() => extractResponse(bad, "local-luna"), (error) => error.status === 502);
  }
  assert.equal(extractResponse(response({ content_filters: null }), "local-luna").azure_content_filters, null);
});

test("phase and deployment configuration cannot silently lose intended semantics", () => {
  const body = { messages: [{ role: "assistant", content: null, phase: "commentary", tool_calls: [historyCall()] }, { role: "tool", tool_call_id: "call_1", content: "output" }] };
  rejected(body, "messages[0].phase");
  for (const invalidRoute of [{ variant: "gpt-5" }, { version: "" }, { variant: undefined }]) {
    const config = configuration(); Object.assign(config.models["local-luna"], invalidRoute);
    assert.throws(() => convert(request(), config), (error) => error.status === 503 && error.code === "invalid_configuration");
  }
});

test("fallback identity/timestamps are deterministic and deployment never substitutes outward alias", () => {
  const first = extractResponse({ status: "completed", output: [] }, "local-luna");
  assert.deepEqual(extractResponse({ status: "completed", output: [] }, "local-luna"), first);
  assert.equal(first.id, "chatcmpl-response"); assert.equal(first.created, 0); assert.equal(first.model, "local-luna");
  assert.throws(() => extractResponse(response(), undefined), (error) => error.status === 502);
});

test("refusal-only output is flagged as a content fallback without changing the outcome", () => {
  const refusalOnly = { id: "r", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "refusal", refusal: "no" }] }] };
  const mapped = extractResponse(refusalOnly, "local-luna");
  assert.equal(mapped.choices[0].message.content, "no");
  assert.equal(mapped.choices[0].message.refusal, "no");
  assert.deepEqual(mapped.bridge_warnings, ["refusal_content_fallback"]);
  const withText = { ...refusalOnly, output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ok" }, { type: "refusal", refusal: "no" }] }] };
  assert.equal(extractResponse(withText, "local-luna").bridge_warnings, undefined);
});
