"use strict";

// Step 6 acceptance matrix: one isolated, in-process Chat-stream check per
// documented Azure Responses event name. No network, filesystem, environment
// reads or imported .test.js helpers are used here.

const assert = require("node:assert/strict");
const { test } = require("node:test");
const inventory = require("./test-fixtures/azure-responses/event-inventory.json");
const { EVENT_REGISTRY, chatPolicyForEvent } = require("./native-events");
const { SseWriter, streamResponse } = require("./sse");

const LIMITS = Object.freeze({
  sseLineBytes: 4 * 1024 * 1024,
  sseEventBytes: 4 * 1024 * 1024,
  sseBufferBytes: 4 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
});
const TIMEOUTS = Object.freeze({ upstreamIdleMs: 500 });
const POLICIES = Object.freeze(["mapped", "noop", "suppressed", "lifecycle", "rejected"]);
const EXPECTED_COUNTS = Object.freeze({ mapped: 13, noop: 8, suppressed: 2, lifecycle: 1, rejected: 29 });
const USAGE = Object.freeze({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
const TERMINAL_OK = "terminal-ok";

class FakeResponse {
  constructor() {
    this.frames = [];
    this.destroyed = false;
    this.writableEnded = false;
    this.headersSent = false;
  }
  writeHead(status, headers) {
    this.statusCode = status;
    this.headers = headers;
    this.headersSent = true;
  }
  flushHeaders() {}
  write(frame) {
    this.frames.push(frame);
    return true;
  }
  end() {
    this.writableEnded = true;
  }
  destroy() {
    this.destroyed = true;
  }
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function frame(eventName, payload) {
  return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function markerFor(index, name) {
  return `MATRIX_${String(index + 1).padStart(2, "0")}_${name.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase()}`;
}

function responseFor(index, status, extra = {}) {
  return {
    id: `resp_${index}`,
    object: "response",
    created_at: 1700000000 + index,
    status,
    model: "gpt-6",
    output: [],
    ...extra,
  };
}

function outputText(text, id = "item_message") {
  return { type: "output_text", text, annotations: [] };
}

function messageItem(text, id = "item_message") {
  return { id, type: "message", role: "assistant", status: "completed", content: [outputText(text)] };
}

function refusalItem(text, id = "item_message") {
  return { id, type: "message", role: "assistant", status: "completed", content: [{ type: "refusal", refusal: text }] };
}

function reasoningItem(text, id = "item_reasoning") {
  return { id, type: "reasoning", status: "completed", summary: [{ type: "summary_text", text }] };
}

function functionItem(argumentsText, index) {
  return {
    id: `item_fn_${index}`,
    type: "function_call",
    call_id: `call_${index}`,
    name: "lookup",
    arguments: argumentsText,
    status: "completed",
  };
}

// Minimal documented field shapes for the 53 enum names. Text fields carry a
// unique marker where the event has one; identity-only events carry it in a
// metadata value or item id so accidental flattening is detectable.
function payloadFor(entry, marker, index) {
  const base = { type: entry.name, sequence_number: index + 1 };
  const outputIndex = 0;
  const itemId = `item_${marker}`;
  const callArgs = JSON.stringify({ query: marker });
  const audioBytes = Buffer.from(marker, "utf8").toString("base64");

  switch (entry.name) {
    case "response.created":
    case "response.in_progress":
      return {
        ...base,
        response: responseFor(index, "in_progress", { metadata: { verification_marker: marker } }),
      };
    case "response.queued":
      return {
        ...base,
        response: responseFor(index, "queued", { metadata: { verification_marker: marker } }),
      };
    case "response.completed":
      return {
        ...base,
        response: responseFor(index, "completed", {
          output: [messageItem(marker, "item_terminal")],
          usage: { ...USAGE },
        }),
      };
    case "response.incomplete":
      return {
        ...base,
        response: responseFor(index, "incomplete", {
          output: [messageItem(marker, "item_terminal")],
          incomplete_details: { reason: "max_output_tokens" },
          usage: { ...USAGE },
        }),
      };
    case "response.failed":
      return {
        ...base,
        response: responseFor(index, "failed", {
          error: { code: "server_error", message: `provider failure ${marker}` },
          usage: { ...USAGE },
        }),
      };
    case "error":
      return { ...base, code: "server_error", message: `provider failure ${marker}`, param: null };
    case "response.output_text.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, delta: marker, logprobs: [] };
    case "response.refusal.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, delta: marker };
    case "response.reasoning_summary_text.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, summary_index: 0, delta: marker };
    case "response.output_item.added":
      return {
        ...base,
        output_index: outputIndex,
        item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
      };
    case "response.output_item.done":
      return { ...base, output_index: outputIndex, item: messageItem(marker, itemId) };
    case "response.function_call_arguments.delta":
      return { ...base, item_id: `item_fn_${index}`, output_index: outputIndex, delta: callArgs };
    case "response.function_call_arguments.done":
      return { ...base, item_id: `item_fn_${index}`, output_index: outputIndex, name: "lookup", arguments: callArgs };
    case "response.content_part.added":
    case "response.content_part.done":
      return {
        ...base,
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", text: marker, annotations: [] },
      };
    case "response.output_text.done":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, text: marker, logprobs: [] };
    case "response.refusal.done":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, refusal: marker };
    case "response.reasoning_summary_part.added":
    case "response.reasoning_summary_part.done":
      return {
        ...base,
        item_id: itemId,
        output_index: outputIndex,
        summary_index: 0,
        part: { type: "summary_text", text: marker },
      };
    case "response.reasoning_summary_text.done":
      return { ...base, item_id: itemId, output_index: outputIndex, summary_index: 0, text: marker };
    case "response.reasoning_text.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, delta: marker };
    case "response.reasoning_text.done":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, text: marker };
    case "response.output_text.annotation.added":
      return {
        ...base,
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        annotation_index: 0,
        annotation: {
          type: "url_citation",
          url: "https://example.invalid/citation",
          title: marker,
          start_index: 0,
          end_index: 1,
        },
      };
    case "response.audio.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, delta: audioBytes };
    case "response.audio.done":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0 };
    case "response.audio.transcript.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, delta: marker };
    case "response.audio.transcript.done":
      return { ...base, item_id: itemId, output_index: outputIndex, content_index: 0, transcript: marker };
    case "response.code_interpreter_call_code.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, delta: marker };
    case "response.code_interpreter_call_code.done":
      return { ...base, item_id: itemId, output_index: outputIndex, code: marker };
    case "response.code_interpreter_call.completed":
    case "response.code_interpreter_call.in_progress":
    case "response.code_interpreter_call.interpreting":
    case "response.file_search_call.completed":
    case "response.file_search_call.in_progress":
    case "response.file_search_call.searching":
    case "response.web_search_call.completed":
    case "response.web_search_call.in_progress":
    case "response.web_search_call.searching":
      return { ...base, item_id: itemId, output_index: outputIndex };
    case "response.image_generation_call.completed":
      return { ...base, item_id: itemId, output_index: outputIndex, result: audioBytes };
    case "response.image_generation_call.generating":
    case "response.image_generation_call.in_progress":
      return { ...base, item_id: itemId, output_index: outputIndex };
    case "response.image_generation_call.partial_image":
      return {
        ...base,
        item_id: itemId,
        output_index: outputIndex,
        partial_image_index: 0,
        partial_image_b64: audioBytes,
      };
    case "response.mcp_call_arguments.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, delta: marker };
    case "response.mcp_call_arguments.done":
      return { ...base, item_id: itemId, output_index: outputIndex, arguments: callArgs };
    case "response.mcp_call.completed":
    case "response.mcp_call.in_progress":
      return { ...base, item_id: itemId, output_index: outputIndex };
    case "response.mcp_call.failed":
      return {
        ...base,
        item_id: itemId,
        output_index: outputIndex,
        error: { code: "server_error", message: `mcp failure ${marker}` },
      };
    case "response.mcp_list_tools.completed":
    case "response.mcp_list_tools.in_progress":
      return { ...base, item_id: itemId, output_index: outputIndex };
    case "response.mcp_list_tools.failed":
      return {
        ...base,
        item_id: itemId,
        output_index: outputIndex,
        error: { code: "server_error", message: `list failure ${marker}` },
      };
    case "response.custom_tool_call_input.delta":
      return { ...base, item_id: itemId, output_index: outputIndex, delta: marker };
    case "response.custom_tool_call_input.done":
      return { ...base, item_id: itemId, output_index: outputIndex, input: marker };
    default:
      throw new Error(`acceptance matrix has no payload for ${entry.name}`);
  }
}

function terminalResponse(index, output, extra = {}) {
  const response = responseFor(index, "completed", { usage: { ...USAGE }, ...extra });
  if (output === undefined) delete response.output;
  else response.output = output;
  return { type: "response.completed", sequence_number: index + 100, response };
}

function scenarioFor(entry, marker, index) {
  const payload = payloadFor(entry, marker, index);
  const prelude = [];
  let terminal = null;

  switch (entry.name) {
    case "response.completed":
    case "response.failed":
    case "response.incomplete":
    case "error":
      break;
    case "response.created":
    case "response.in_progress":
      terminal = terminalResponse(index, []);
      break;
    case "response.output_text.delta":
      terminal = terminalResponse(index, [messageItem(marker)]);
      break;
    case "response.refusal.delta":
      terminal = terminalResponse(index, [refusalItem(marker)]);
      break;
    case "response.reasoning_summary_text.delta":
      terminal = terminalResponse(index, [reasoningItem(marker)]);
      break;
    case "response.output_item.added":
      terminal = terminalResponse(index, [messageItem(marker)]);
      break;
    case "response.output_item.done":
      // The terminal omits output; the adapter must reconstruct it from the
      // explicitly done item exactly once.
      terminal = terminalResponse(index, undefined);
      break;
    case "response.function_call_arguments.delta":
    case "response.function_call_arguments.done":
      prelude.push({
        type: "response.output_item.added",
        sequence_number: index + 200,
        output_index: 0,
        item: {
          id: `item_fn_${index}`,
          type: "function_call",
          call_id: `call_${index}`,
          name: "lookup",
          arguments: "",
          status: "in_progress",
        },
      });
      terminal = terminalResponse(index, [functionItem(JSON.stringify({ query: marker }), index)]);
      break;
    default:
      // No-op and suppressed scenarios still need a clean terminal, but it
      // carries unrelated text so any event-marker leak is unambiguous.
      terminal = terminalResponse(index, [messageItem(TERMINAL_OK)]);
      break;
  }

  return { payload, prelude, terminal };
}

function runText(text) {
  const bytes = Buffer.from(text, "utf8");
  let sent = false;
  const body = {
    getReader() {
      return {
        read() {
          if (sent) return Promise.resolve({ done: true });
          sent = true;
          return Promise.resolve({ value: bytes, done: false });
        },
        cancel() {
          return Promise.resolve();
        },
        releaseLock() {},
      };
    },
  };
  const res = new FakeResponse();
  const writer = new SseWriter(res, { stallMs: 100 });
  writer.start();
  const promise = streamResponse({ body }, writer, {
    alias: "matrix-alias",
    limits: LIMITS,
    timeouts: TIMEOUTS,
  });
  return { res, promise };
}

async function verifyQueued(entry, marker, index) {
  const queued = frame("response.queued", payloadFor(entry, marker, index));
  const created = frame("response.created", {
    type: "response.created",
    sequence_number: index + 201,
    response: responseFor(index, "in_progress", {}),
  });
  const delta = frame("response.output_text.delta", {
    type: "response.output_text.delta",
    sequence_number: index + 202,
    item_id: `item_queued_${index}`,
    output_index: 0,
    content_index: 0,
    delta: "ok",
    logprobs: [],
  });
  const terminal = frame(
    "response.completed",
    terminalResponse(index, [messageItem("ok", `item_queued_terminal_${index}`)])
  );
  const rest = created + delta + terminal;

  let release;
  let entered;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const reached = new Promise((resolve) => {
    entered = resolve;
  });
  let reads = 0;
  const body = {
    getReader() {
      return {
        read() {
          reads += 1;
          if (reads === 1) return Promise.resolve({ value: Buffer.from(queued, "utf8"), done: false });
          if (reads === 2) {
            entered();
            return gate;
          }
          return Promise.resolve({ done: true });
        },
        cancel() {
          return Promise.resolve();
        },
        releaseLock() {},
      };
    },
  };
  const res = new FakeResponse();
  const writer = new SseWriter(res, { stallMs: 100 });
  writer.start();
  const promise = streamResponse({ body }, writer, {
    alias: "matrix-alias",
    limits: LIMITS,
    timeouts: TIMEOUTS,
  });

  await reached;
  assert.equal(res.frames.length, 0, "response.queued must not emit a frame (including a role chunk)");
  assert.equal(res.writableEnded, false, "response.queued must not terminate the stream");
  release({ value: Buffer.from(rest, "utf8"), done: false });

  const result = await promise;
  const output = res.frames.join("");
  assert.equal(res.writableEnded, true, "the later response.completed must terminate the stream");
  assert.equal(result.outcome, "completed");
  assert.equal(count(output, '"role":"assistant"'), 1, "the role chunk must come from response.created/terminal, once");
  assert.equal(count(output, "data: [DONE]"), 1, "exactly one Chat terminal marker");
  assert.equal(output.includes(marker), false, "queued metadata must not be flattened into Chat output");
}

async function verifyEntry(entry, index) {
  const marker = markerFor(index, entry.name);
  if (entry.currentChatPolicy === "lifecycle") {
    assert.equal(entry.name, "response.queued");
    await verifyQueued(entry, marker, index);
    return;
  }

  const scenario = scenarioFor(entry, marker, index);
  const parts = [
    ...scenario.prelude.map((payload) => frame(payload.type, payload)),
    frame(entry.name, scenario.payload),
  ];
  if (scenario.terminal) parts.push(frame("response.completed", scenario.terminal));
  const { res, promise } = runText(parts.join(""));

  if (entry.currentChatPolicy === "rejected") {
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, "unsupported_sse_event");
      assert.equal(error.eventName, entry.name);
      assert.equal(error.message, "Upstream SSE event is unsupported");
      assert.equal(error.message.includes(marker), false);
      assert.equal(res.frames.join("").includes(marker), false, "rejected payload text must not reach the client");
      return true;
    });
    assert.equal(res.frames.length, 0, "a rejected event must not emit Chat frames");
    return;
  }

  if (entry.currentChatPolicy === "mapped" && (entry.name === "response.failed" || entry.name === "error")) {
    // These two mapped terminal events deliberately surface a bounded upward
    // error instead of resolving the stream; neither is an unsupported-event
    // rejection and neither emits client frames.
    await assert.rejects(promise, (error) => {
      assert.equal(error.code, "server_error");
      assert.notEqual(error.code, "unsupported_sse_event");
      assert.equal(error.eventName, entry.name);
      assert.equal(error.status, 502);
      assert.equal(res.frames.length, 0);
      return true;
    });
    return;
  }

  const result = await promise;
  const output = res.frames.join("");
  assert.equal(res.writableEnded, true, `${entry.name} must terminate normally`);
  assert.equal(count(output, "data: [DONE]"), 1, `${entry.name} must emit exactly one DONE`);
  assert.equal(count(output, '"role":"assistant"'), 1, `${entry.name} must emit the assistant role exactly once`);

  if (entry.currentChatPolicy === "mapped") {
    if (entry.name === "response.incomplete") {
      assert.equal(result.outcome, "incomplete");
      assert.equal(result.finishReason, "length");
    } else {
      assert.equal(result.outcome, "completed", `${entry.name} outcome`);
    }

    if (entry.name === "response.created" || entry.name === "response.in_progress") {
      assert.equal(output.includes(marker), false, "lifecycle metadata must not be flattened into Chat content");
    } else if (entry.name === "response.refusal.delta") {
      // The adapter maps a refusal into both the native refusal field and the
      // Chat content fallback, so the marker legitimately appears twice, but
      // the refusal material itself is emitted once.
      assert.equal(count(output, `"refusal":"${marker}"`), 1, "refusal delta must not be re-emitted");
      assert.equal(count(output, marker), 2, "refusal content fallback is emitted once");
    } else {
      assert.equal(count(output, marker), 1, `${entry.name} material must not be duplicated`);
    }

    if (entry.name === "response.function_call_arguments.delta" || entry.name === "response.function_call_arguments.done") {
      // "tool_calls" also appears as the terminal finish_reason, so match the
      // delta array itself rather than the bare field name.
      assert.equal(count(output, '"tool_calls":['), 1, "function call must be emitted exactly once at the terminal");
    }
    return;
  }

  // noop and suppressed
  assert.equal(output.includes(marker), false, `${entry.currentChatPolicy} event must not contribute Chat content`);
  if (entry.currentChatPolicy === "suppressed") {
    assert.equal(output.includes("reasoning_content"), false, "raw reasoning must never be surfaced");
  }
}

test("event inventory has exactly 53 entries with recognized Chat policies and exact counts", () => {
  assert.equal(inventory.entries.length, 53);
  const names = inventory.entries.map((entry) => entry.name);
  assert.equal(new Set(names).size, 53, "documented event names must be unique");

  const counts = { mapped: 0, noop: 0, suppressed: 0, lifecycle: 0, rejected: 0 };
  for (const entry of inventory.entries) {
    assert.ok(POLICIES.includes(entry.currentChatPolicy), `${entry.name} has unknown policy ${entry.currentChatPolicy}`);
    counts[entry.currentChatPolicy] += 1;
  }
  assert.deepEqual(counts, EXPECTED_COUNTS);
  assert.equal(inventory.counts.currentChatMappedDocumentedEvents, EXPECTED_COUNTS.mapped);
  assert.equal(inventory.counts.currentChatNoopDocumentedEvents, EXPECTED_COUNTS.noop);
  assert.equal(inventory.counts.currentChatSuppressedRawReasoningDocumentedEvents, EXPECTED_COUNTS.suppressed);
  assert.equal(inventory.counts.currentChatLifecycleNotificationDocumentedEvents, EXPECTED_COUNTS.lifecycle);
  assert.equal(inventory.counts.currentChatRejectedDocumentedEvents, EXPECTED_COUNTS.rejected);
});

test("event inventory matches the authoritative native-event registry", () => {
  assert.deepEqual(
    inventory.entries.map((entry) => entry.name).sort(),
    Object.keys(EVENT_REGISTRY).sort(),
    "fixture event names must equal the native event registry keys"
  );

  for (const entry of inventory.entries) {
    assert.ok(EVENT_REGISTRY[entry.name], `${entry.name} is listed in the fixture but missing from EVENT_REGISTRY`);
    assert.equal(EVENT_REGISTRY[entry.name].category, entry.category, `${entry.name} category drifted from EVENT_REGISTRY`);
    assert.equal(chatPolicyForEvent(entry.name), entry.currentChatPolicy, `${entry.name} Chat policy drifted from the registry-derived policy`);
  }

  for (const entry of inventory.extraCompatibilityNames) {
    assert.equal(Object.hasOwn(EVENT_REGISTRY, entry.name), false, `${entry.name} is compatibility-only and must not be in EVENT_REGISTRY`);
    assert.equal(chatPolicyForEvent(entry.name), entry.currentChatPolicy, `${entry.name} compatibility Chat policy drifted from the registry-derived policy`);
  }
});

test("Chat acceptance matrix drives every documented event through streamResponse", async (t) => {
  for (let index = 0; index < inventory.entries.length; index += 1) {
    const entry = inventory.entries[index];
    await t.test(`${entry.currentChatPolicy}: ${entry.name}`, async () => {
      await verifyEntry(entry, index);
    });
  }
});
