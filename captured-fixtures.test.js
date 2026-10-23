"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { validateConfig } = require("./config");
const { validateNativeEvent } = require("./native-events");
const { validateNativeRequest, createNativeResponsePolicy, validateNativeResponse } = require("./native-request");

const DIR = path.join(__dirname, "test-fixtures", "azure-responses", "captured");
const MAX_FIXTURE_BYTES = 2 * 1024 * 1024;
const SECRET_PATTERNS = [
  ["provider key", /sk-[A-Za-z0-9_-]{20,}/],
  ["api-key header", /"api-key"/i],
  ["Authorization header", /"Authorization"/i],
  ["long credential field", /"[A-Za-z0-9_.-]*_(?:key|token)"\s*:\s*"[^"]{17,}"/i],
];
const reason = shape => `no capture at test-fixtures/azure-responses/captured/${shape}.json; run the approved capture harness first`;
const skip = shape => (fs.existsSync(path.join(DIR, `${shape}.json`)) ? false : reason(shape));
function fileOf(capture) {
  return `test-fixtures/azure-responses/captured/${capture.file}`;
}
function fixture(shape) {
  const capture = captures().get(shape);
  assert.ok(capture, `${reason(shape)} (a file exists but the loader did not key it as ${shape})`);
  return capture;
}

let loaded;
function captures() {
  if (loaded === undefined) loaded = loadCaptures();
  return loaded;
}
function loadCaptures(dir = DIR) {
  const found = new Map();
  if (!fs.existsSync(dir)) return found;
  for (const name of fs.readdirSync(dir).filter(entry => entry.endsWith(".json")).sort()) {
    const raw = fs.readFileSync(path.join(dir, name), "utf8");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(`${name}: malformed capture JSON (${error.message})`);
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${name}: malformed capture: expected a JSON object`);
    const stem = name.slice(0, -".json".length);
    const shape = typeof parsed.shape === "string" && parsed.shape ? parsed.shape : stem;
    if (found.has(shape)) throw new Error(`${name}: duplicate capture shape ${shape}`);
    found.set(shape, Object.freeze({ ...parsed, file: name, raw }));
  }
  return found;
}
function config(extra = {}) {
  return validateConfig({ azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"], azureApiKey: "fixture-upstream", proxyToken: "fixture-local", defaultModel: "local", models: { local: { deployment: "deployment", variant: "gpt-6-luna", version: "v" } }, ...extra });
}
function imageConfig(alias, policy) {
  // An image-generation grant requires the operator-configured routing header, so the fixture declares one.
  return validateConfig({ azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"], azureApiKey: "fixture-upstream", proxyToken: "fixture-local", defaultModel: alias, models: { [alias]: { deployment: "deployment", variant: "gpt-6-luna", version: "v", profile: { images: true }, nativeHeaders: { "x-ms-oai-image-generation-deployment": "img-deploy" } } }, nativePolicies: { [alias]: policy } });
}
function reasoningPolicy() {
  return createNativeResponsePolicy(validateNativeRequest({ input: "x", include: ["reasoning.encrypted_content"] }, config()));
}
function accepts(response, policyBody, file, label) {
  try {
    return validateNativeResponse(response, policyBody);
  } catch (error) {
    assert.fail(`${file}: ${label} contradicts the bridge policy (${error.code || error.message})`);
  }
}
function terminalResponse(capture) {
  if (capture.response && typeof capture.response === "object") return capture.response;
  for (let index = capture.events.length - 1; index >= 0; index--) {
    const event = capture.events[index];
    if (event && ["response.completed", "response.failed", "response.incomplete"].includes(event.type) && event.response && typeof event.response === "object") return event.response;
  }
  return null;
}
function functionCalls(capture, terminal) {
  const calls = new Map();
  const add = item => { if (item && item.type === "function_call" && typeof item.call_id === "string" && !calls.has(item.call_id)) calls.set(item.call_id, item); };
  if (terminal && Array.isArray(terminal.output)) terminal.output.forEach(add);
  for (const event of capture.events) if (event && event.type === "response.output_item.done" && event.item) add(event.item);
  return [...calls.values()];
}
function providerMessages(capture) {
  const messages = [];
  const add = error => {
    if (!error || typeof error !== "object") return;
    for (const key of ["message", "code", "param"]) if (typeof error[key] === "string" && error[key]) messages.push(error[key]);
  };
  add(capture.response && capture.response.error);
  for (const event of capture.events) {
    if (!event || event.type !== "error") continue;
    add(event.error);
    add(event);
  }
  return messages;
}

test("captured fixtures are self-describing, endpoint-bound and secret-free", () => {
  for (const [shape, capture] of captures()) {
    const file = fileOf(capture);
    assert.equal(capture.shape, shape, `${file}: shape must match its file name`);
    assert.equal(shape, capture.file.slice(0, -".json".length), `${file}: shape must match its file name`);
    assert.equal(typeof capture.approval, "string", `${file}: approval must be a string`);
    assert.equal(capture.endpoint, "/v1/responses", `${file}: endpoint must be /v1/responses`);
    assert.ok(Number.isInteger(capture.status), `${file}: status must be an integer`);
    assert.ok(Array.isArray(capture.events), `${file}: events must be an array`);
    assert.ok(capture.request !== null && typeof capture.request === "object" && !Array.isArray(capture.request), `${file}: request must be an object`);
    for (const [label, pattern] of SECRET_PATTERNS) {
      const match = capture.raw.match(pattern);
      assert.equal(match, null, `${file}: possible secret (${label}): ${match && match[0]}`);
    }
  }
});

test("flat error captures validate as terminal provider errors", { skip: skip("flat-error") }, t => {
  const capture = fixture("flat-error");
  const file = fileOf(capture);
  const errors = capture.events.filter(event => event && event.type === "error");
  if (!errors.length) {
    // Azure rejects pre-flight validation failures with a JSON body rather than an SSE error event.
    const body = capture.response && capture.response.error;
    assert.ok(body && typeof body === "object", `${file}: no error event and no JSON error body; status ${capture.status} is not flat-error evidence`);
    assert.equal(typeof body.message, "string", `${file}: provider error body must carry a string message`);
    assert.equal(typeof body.type, "string", `${file}: provider error body must carry a string type`);
    for (const key of ["code", "param"]) if (Object.hasOwn(body, key) && body[key] !== null) assert.equal(typeof body[key], "string", `${file}: provider error ${key} must be a string when present`);
    t.diagnostic(`${file}: provider returned a JSON error body (status ${capture.status}, code ${body.code}), not an SSE error event`);
    return;
  }
  for (const payload of errors) {
    let verdict;
    try {
      verdict = validateNativeEvent("error", payload);
    } catch (error) {
      assert.fail(`${file}: captured error event contradicts validateNativeEvent (${error.message})`);
    }
    assert.equal(verdict.terminal, true, `${file}: captured error event must be terminal`);
  }
  const optional = errors.some(payload => !Object.hasOwn(payload, "param") || !Object.hasOwn(payload, "sequence_number"));
  if (!optional) t.diagnostic(`${file}: provider included both param and sequence_number; the optional-field allowance was not exercised`);
});

test("reasoning items with nullable summary still validate against the response policy", { skip: skip("reasoning-nullable-summary") }, t => {
  const capture = fixture("reasoning-nullable-summary");
  const file = fileOf(capture);
  const response = terminalResponse(capture);
  const items = [];
  if (response && Array.isArray(response.output)) items.push(...response.output);
  for (const event of capture.events) if (event && event.type && event.type.startsWith("response.output_item.") && event.item) items.push(event.item);
  const nullable = items.find(item => item && item.type === "reasoning" && (!Object.hasOwn(item, "summary") || item.summary === null));
  if (!nullable) {
    t.diagnostic(`${file}: provider returned no reasoning item with null or absent summary; absence is not contradiction`);
    return;
  }
  assert.ok(response && Array.isArray(response.output), `${file}: nullable reasoning appeared without a terminal response to validate`);
  accepts(response, reasoningPolicy(), file, "reasoning item with nullable summary");
});

test("output_text parts with nullable annotations still validate against the response policy", { skip: skip("annotations-null") }, t => {
  const capture = fixture("annotations-null");
  const file = fileOf(capture);
  const response = terminalResponse(capture);
  const parts = [];
  if (response && Array.isArray(response.output)) for (const item of response.output) if (item && item.type === "message" && Array.isArray(item.content)) parts.push(...item.content);
  for (const event of capture.events) {
    if (!event) continue;
    if ((event.type === "response.content_part.added" || event.type === "response.content_part.done") && event.part) parts.push(event.part);
    if (event.type === "response.output_item.done" && event.item && Array.isArray(event.item.content)) parts.push(...event.item.content);
  }
  const nullable = parts.find(part => part && part.type === "output_text" && (!Object.hasOwn(part, "annotations") || part.annotations === null));
  if (!nullable) {
    t.diagnostic(`${file}: provider returned no output_text part with null or absent annotations; absence is not contradiction`);
    return;
  }
  assert.ok(response && Array.isArray(response.output), `${file}: nullable annotations appeared without a terminal response to validate`);
  accepts(response, reasoningPolicy(), file, "output_text part with nullable annotations");
});

test("streaming image generation needs the verified capability", { skip: skip("image-streaming") }, () => {
  const capture = fixture("image-streaming");
  const file = fileOf(capture);
  const request = capture.request;
  const imageModels = [...new Set((Array.isArray(request.tools) ? request.tools : []).filter(tool => tool && tool.type === "image_generation" && typeof tool.model === "string" && tool.model).map(tool => tool.model))];
  assert.ok(imageModels.length > 0, `${file}: request declares no image_generation model; not image-streaming evidence`);
  const alias = typeof request.model === "string" && request.model ? request.model : "local";
  const granted = { features: ["image-generation", "image-input"], imageModels };
  const verified = imageConfig(alias, { ...granted, verifiedCapabilities: ["image-generation-streaming"] });
  const unverified = imageConfig(alias, granted);
  assert.ok(validateNativeRequest(request, verified), `${file}: bridge must accept the captured request with the verified streaming capability`);
  assert.throws(() => validateNativeRequest(request, unverified), { code: "unsupported_parameter", param: "stream" }, `${file}: the same request must be rejected without image-generation-streaming`);
});

test("output token boundary stays within the configured cap or records a provider finding", { skip: skip("output-boundary") }, t => {
  const capture = fixture("output-boundary");
  const file = fileOf(capture);
  if (capture.status >= 200 && capture.status < 300) {
    const response = capture.response;
    assert.ok(response && typeof response === "object", `${file}: 2xx capture has no response body`);
    const usage = response.usage;
    if (usage && typeof usage === "object" && Number.isSafeInteger(usage.output_tokens)) {
      const limit = capture.request.max_output_tokens;
      if (Number.isSafeInteger(limit)) assert.ok(usage.output_tokens <= limit, `${file}: output_tokens ${usage.output_tokens} exceeds max_output_tokens ${limit}`);
      else t.diagnostic(`${file}: no explicit max_output_tokens; usage ${usage.output_tokens} cannot be compared with the configured default`);
    }
    accepts(response, reasoningPolicy(), file, "output-boundary response");
    return;
  }
  assert.ok(capture.status >= 400 && capture.status < 500, `${file}: expected a 2xx success or 4xx rejection, got status ${capture.status}`);
  const messages = providerMessages(capture);
  const text = messages.join(" | ");
  assert.ok(/token|context[_ ]length|max[_ ](?:output|completion)/i.test(text), `${file}: 4xx capture does not record a token-related rejection: ${text || "no provider message"}`);
  t.diagnostic(`${file}: provider rejected the token boundary (status ${capture.status}): ${text}`);
});

test("multi-call captures return at least two declared function calls", { skip: skip("multi-call") }, t => {
  const capture = fixture("multi-call");
  const file = fileOf(capture);
  const terminal = terminalResponse(capture);
  const calls = functionCalls(capture, terminal);
  for (const call of calls) {
    assert.equal(typeof call.call_id, "string", `${file}: function_call item without a string call_id`);
    assert.equal(typeof call.arguments, "string", `${file}: function_call ${call.call_id} without string arguments`);
  }
  if (calls.length < 2) {
    t.diagnostic(`${file}: only ${calls.length} function_call item(s) captured`);
    const status = terminal && typeof terminal.status === "string" ? terminal.status : capture.status >= 400 ? "failed" : undefined;
    assert.ok(status !== undefined, `${file}: cannot establish that the ${calls.length}-call response is not completed`);
    assert.notEqual(status, "completed", `${file}: completed response returned ${calls.length} function_call item(s), expected at least two`);
    return;
  }
  const tools = ["probe_a", "probe_b"].map(name => ({ type: "function", name, parameters: null, strict: false }));
  const policyBody = createNativeResponsePolicy(validateNativeRequest({ input: "x", tools }, config({ nativePolicies: { local: { features: [], customToolNames: ["probe_a", "probe_b"] } } })));
  const envelope = terminal && Array.isArray(terminal.output) ? terminal : { id: "captured-multi-call", object: "response", status: "completed", output: calls };
  if (envelope !== terminal) t.diagnostic(`${file}: no terminal response was captured; the policy check uses the captured calls in a minimal envelope`);
  const accepted = policyBody({ name: "response.completed", known: true, category: "lifecycle-terminal" }, { response: envelope });
  assert.equal(accepted, true, `${file}: policy rejected a terminal response containing ${calls.length} captured function calls`);
});

test("captured fixtures stay small and carry an approval reference", () => {
  if (!fs.existsSync(DIR)) return;
  const names = fs.readdirSync(DIR).filter(name => name.endsWith(".json"));
  if (!names.length) return;
  const found = captures();
  for (const name of names) {
    const size = fs.statSync(path.join(DIR, name)).size;
    assert.ok(size <= MAX_FIXTURE_BYTES, `${name}: ${size} bytes exceeds the 2 MiB capture budget`);
    const capture = found.get(name.slice(0, -".json".length));
    assert.ok(capture && typeof capture.approval === "string" && capture.approval.trim().length > 0, `${name}: approval must be a non-empty reference`);
  }
});
