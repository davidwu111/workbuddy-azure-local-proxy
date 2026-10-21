"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { EventEmitter } = require("node:events");
const { createLogger, validateLogPath, safeRecord, localTimestamp } = require("./logger");
const { safeValidationParam, valueTypeAtParam, validationDiagnostics } = require("./diagnostics");
const { CHAT_REQUEST_FIELDS, CHAT_MESSAGE_FIELDS, normalizeChatDefaults } = require("./chat-contract");
test("Chat recognition covers the audited field set without claiming every feature is mapped", () => {
  assert.equal(CHAT_REQUEST_FIELDS.length, 37); assert.equal(new Set(CHAT_REQUEST_FIELDS).size, 37);
  for (const key of ["audio", "functions", "moderation", "prediction", "safety_identifier", "web_search_options", "service_tier", "prompt_cache_retention"]) assert.ok(CHAT_REQUEST_FIELDS.includes(key));
  assert.ok(CHAT_MESSAGE_FIELDS.user.includes("name")); assert.equal(CHAT_MESSAGE_FIELDS.user.includes("agent"), false);
  const input = Object.freeze({ frequency_penalty: 0, logprobs: true, top_logprobs: 0, stream_options: Object.freeze({ include_obfuscation: false, include_usage: true }), web_search_options: null });
  const normalized = normalizeChatDefaults(input);
  assert.equal(normalized.body.logprobs, true); assert.equal(normalized.body.top_logprobs, 0);
  assert.equal(normalized.body.web_search_options, null); assert.equal(normalized.body.stream_options.include_usage, true);
  assert.equal(input.stream_options.include_obfuscation, false);
});

test("validation telemetry preserves safe field paths/types but never request values or opaque schema keys", () => {
  const input = { messages: [{ role: "user", content: "PROMPT_PRIVATE_MARKER", agent: { private: "AGENT_PRIVATE_MARKER" } }], tools: [{ function: { parameters: { privateSchemaName: "SCHEMA_PRIVATE_MARKER" } } }] };
  const error = { status: 400, type: "invalid_request_error", code: "unsupported_parameter", param: "messages[0].agent", message: "PROMPT_PRIVATE_MARKER" };
  const projected = validationDiagnostics(error, "request_conversion", input);
  assert.equal(projected.validationParam, "messages[0].agent"); assert.equal(projected.validationValueType, "object");
  assert.equal(projected.validationCode, "unsupported_parameter");
  assert.equal(safeValidationParam("tools[0].function.parameters.privateSchemaName"), "tools[0].function.parameters");
  assert.equal(safeValidationParam("messages[0].PrivatePromptAsField"), "messages[0].<unknown_field>");
  assert.equal(safeValidationParam("messages[0].private phrase with spaces"), "messages[0].<unknown_field>");
  assert.equal(safeValidationParam("messages[0].agent", ["agent"]), "<redacted_parameter>");
  const record = safeRecord("request", { ...projected, body: input, message: error.message, error, normalizedFields: ["frequency_penalty", "PRIVATE_VALUE"] });
  const serialized = JSON.stringify(record);
  for (const marker of ["PROMPT_PRIVATE_MARKER", "AGENT_PRIVATE_MARKER", "SCHEMA_PRIVATE_MARKER", "PRIVATE_VALUE", "privateSchemaName"]) assert.equal(serialized.includes(marker), false);
  assert.equal(record.stage, "request_conversion"); assert.deepEqual(record.normalizedFields, ["frequency_penalty"]);
  assert.deepEqual(validationDiagnostics({ ...error, status: 502 }, "response_conversion", input), {});
});

test("type-only diagnostics do not invoke getters or serialize malformed bodies", () => {
  let calls = 0; const input = {};
  Object.defineProperty(input, "agent", { get() { calls++; throw new Error("PRIVATE_MARKER"); } });
  assert.equal(valueTypeAtParam(input, "agent"), "unavailable"); assert.equal(calls, 0);
  assert.equal(valueTypeAtParam({ messages: [{ agent: false }] }, "messages[0].agent"), "boolean");
  assert.equal(valueTypeAtParam({ metadata: null }, "metadata"), "null");
  assert.equal(valueTypeAtParam({}, "private path with spaces"), "unavailable");
  assert.equal(safeValidationParam("x".repeat(1000)), "<redacted_parameter>");
});

test("unknown message key names are reported for diagnosis while values stay private", () => {
  const error = { status: 400, type: "invalid_request_error", code: "unknown_parameter", param: "messages[1].conversationRequestId" };
  const projected = validationDiagnostics(error, "request_conversion", { messages: [{ role: "user", content: "PRIVATE" }, { role: "tool", content: "PRIVATE", conversationRequestId: "PRIVATE_MARKER" }] });
  assert.equal(projected.validationKey, "conversationRequestId");
  assert.equal(projected.validationParam, "messages[1].conversationRequestId");
  assert.equal(projected.validationValueType, "string");
  const record = safeRecord("request", { ...projected, body: { secret: "PRIVATE_MARKER" } });
  assert.equal(record.validationKey, "conversationRequestId");
  assert.equal(JSON.stringify(record).includes("PRIVATE_MARKER"), false);
  // Only unknown_parameter message paths yield a key. Keys are protocol surface,
  // so they are reported; control characters are masked.
  assert.equal(validationDiagnostics({ ...error, code: "invalid_parameter" }, "request_conversion", null).validationKey, undefined);
  assert.equal(validationDiagnostics({ ...error, param: "messages[1].has spaces" }, "request_conversion", null).validationKey, "has spaces");
  assert.equal(validationDiagnostics({ ...error, param: "messages[1].$ref" }, "request_conversion", null).validationKey, "$ref");
  assert.equal(validationDiagnostics({ ...error, param: "messages[1].bad\nkey" }, "request_conversion", null).validationKey, "bad?key");
  assert.equal(validationDiagnostics({ ...error, param: "messages[1]." + "k".repeat(129) }, "request_conversion", null).validationKey, undefined);
  assert.equal(validationDiagnostics({ ...error, param: "body.agent" }, "request_conversion", null).validationKey, undefined);
  assert.equal(safeRecord("request", { validationKey: "not a key" }).validationKey, "not a key");
  assert.equal(safeRecord("request", { validationKey: "x".repeat(129) }).validationKey, undefined);
  // Auto-mode normalisation names are logged for bounded keys only, including
  // namespaced client keys observed in tool-call follow-ups. Unusual characters
  // are masked out of the recorded name rather than dropped.
  assert.deepEqual(safeRecord("request", { normalizedFields: ["messages.turnToken", "messages.not a name", "messages." + "x".repeat(140), "messages.a.b-c:d"] }).normalizedFields, ["messages.turnToken", "messages.not a name", "messages.a.b-c:d"]);
});

test("local timestamps preserve the instant, milliseconds, timezone offsets, rollover and DST", () => {
  const originalTZ = process.env.TZ;
  const cases = [
    ["UTC", "2026-01-01T00:00:00.007Z", "2026-01-01T00:00:00.007+00:00"],
    ["Asia/Shanghai", "2026-12-31T23:59:59.007Z", "2027-01-01T07:59:59.007+08:00"],
    ["Asia/Kolkata", "2026-01-01T00:00:00.007Z", "2026-01-01T05:30:00.007+05:30"],
    ["Asia/Kathmandu", "2026-01-01T00:00:00.007Z", "2026-01-01T05:45:00.007+05:45"],
    ["America/New_York", "2026-01-01T00:00:00.007Z", "2025-12-31T19:00:00.007-05:00"],
    ["America/New_York", "2026-07-01T12:00:00.007Z", "2026-07-01T08:00:00.007-04:00"],
  ];
  try {
    for (const [zone, instant, expected] of cases) {
      process.env.TZ = zone; const date = new Date(instant);
      assert.equal(localTimestamp(date), expected);
      assert.equal(Date.parse(localTimestamp(date)), date.getTime());
      assert.equal(safeRecord("request", { time: "override", event: "override" }, date).time, expected);
    }
    assert.throws(() => localTimestamp(new Date(NaN)), RangeError);
  } finally { if (originalTZ === undefined) delete process.env.TZ; else process.env.TZ = originalTZ; }
});
test("console and temporary-file log records share the same local timestamp with an explicit offset", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-local-time-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const lines = []; const destination = path.join(temp, "fixture.log");
  const log = createLogger({ logPath: destination, stdout: { write(line) { lines.push(line); return true; }, off() {} } });
  log("request", { outcome: "completed" }); await log.close();
  const consoleRecord = JSON.parse(lines[0]); const fileRecord = JSON.parse(await fs.readFile(destination, "utf8"));
  assert.deepEqual(consoleRecord, fileRecord);
  assert.match(fileRecord.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
  const date = new Date(fileRecord.time), offset = -date.getTimezoneOffset();
  const expectedSuffix = `${offset >= 0 ? "+" : "-"}${String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")}:${String(Math.abs(offset) % 60).padStart(2, "0")}`;
  assert.ok(fileRecord.time.endsWith(expectedSuffix));
});
test("safe logging cannot overwrite event or include prompt, tool or opaque state", () => {
  const r = safeRecord("stream_failed", { event: "attacker", message: "fixture-private", prompt: "fixture-private",
    tool_arguments: "fixture-private", encrypted_content: "fixture-private", proxyToken: "fixture-private",
    status: 200, outcome: "upstream_error", requestId: "safe-id", usage: { input_tokens: 0,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 12, opaque: "fixture-private" },
      output_tokens_details: { reasoning_tokens: 0 }, secret: "fixture-private" } });
  assert.equal(r.event, "stream_failed"); assert.equal(r.status, 200); assert.ok(!JSON.stringify(r).includes("fixture-private"));
  assert.equal(r.usage.input_tokens, 0); assert.equal(r.usage.input_tokens_details.cache_write_tokens, 12);
  assert.equal(safeRecord("request", { path: "/a-private-value" }).path, "unmatched");
});
test("asynchronous file logging has bounded buffering and rotates only its isolated destination", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "fixture.log");
  const log = createLogger({ logPath: destination, stdout: null, maxQueueBytes: 512, maxLogBytes: 180 });
  for (let i = 0; i < 100; i++) log("request", { status: 200, requestId: `safe-${i}` });
  assert.ok(log.stats().queuedBytes <= 512); assert.ok(log.stats().dropped > 0);
  await log.flush(); log("shutdown", { outcome: "ok" }); await log.close();
  const content = await fs.readFile(destination, "utf8"); assert.ok(Buffer.byteLength(content) <= 180);
  // Size rotation archives to a dated, sequenced sibling of the active log.
  const archives = (await fs.readdir(temp)).filter(name => /^fixture-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name));
  assert.ok(archives.length >= 1, `expected dated archive, got ${(await fs.readdir(temp)).join(",")}`);
  assert.ok((await fs.readFile(path.join(temp, archives[0]), "utf8")).includes("request"));
  assert.equal(log("ignored", {}), false);
});
test("rotation preserves colliding archives across logger restarts", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-restart-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "bridge.log");
  const clock = new Date(2026, 9, 21, 12);
  const first = path.join(temp, "bridge-2026-10-21.1.log");
  await fs.writeFile(first, "existing-archive\n");
  for (let i = 0; i < 2; i++) {
    await fs.writeFile(destination, `active-before-restart-${i}\n`);
    await fs.utimes(destination, clock, clock);
    const log = createLogger({ logPath: destination, stdout: null, maxLogBytes: 110, now: () => clock });
    log("request", { outcome: "force-size-rotation" }); await log.close();
    assert.equal(log.stats().dropped, 0);
    if (process.platform !== "win32") assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  }
  assert.equal(await fs.readFile(first, "utf8"), "existing-archive\n");
  assert.equal(await fs.readFile(path.join(temp, "bridge-2026-10-21.2.log"), "utf8"), "active-before-restart-0\n");
  assert.equal(await fs.readFile(path.join(temp, "bridge-2026-10-21.3.log"), "utf8"), "active-before-restart-1\n");
});
test("the first post-restart write archives a previous-day active log without clobbering", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-prior-day-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "bridge.log");
  const prior = new Date(2026, 9, 20, 23, 59);
  await fs.writeFile(destination, "prior-day-active\n"); await fs.utimes(destination, prior, prior);
  await fs.writeFile(path.join(temp, "bridge-2026-10-20.log"), "prior-day-archive\n");
  const log = createLogger({ logPath: destination, stdout: null, now: () => new Date(2026, 9, 21, 12) });
  log("request", { outcome: "new-day" }); await log.close();
  assert.equal(await fs.readFile(path.join(temp, "bridge-2026-10-20.log"), "utf8"), "prior-day-archive\n");
  assert.equal(await fs.readFile(path.join(temp, "bridge-2026-10-20.1.log"), "utf8"), "prior-day-active\n");
  assert.equal((await fs.readFile(destination, "utf8")).includes("prior-day"), false);
});
test("runtime log validation preserves bytes, creates private regular files and rejects directories", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-validate-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "fixture.log");
  await validateLogPath(undefined);
  await validateLogPath(destination); assert.equal((await fs.stat(destination)).isFile(), true);
  if (process.platform !== "win32") assert.equal((await fs.stat(destination)).mode & 0o777, 0o600);
  await fs.writeFile(destination, "preserve-me\n"); await validateLogPath(destination);
  assert.equal(await fs.readFile(destination, "utf8"), "preserve-me\n");
  await assert.rejects(validateLogPath(temp), { code: "INVALID_CONFIG", param: "logPath" });
  await assert.rejects(validateLogPath(path.join(temp, "missing", "fixture.log")), { code: "INVALID_CONFIG", param: "logPath" });
  if (process.platform !== "win32") {
    await assert.rejects(validateLogPath("/dev/null"), { code: "INVALID_CONFIG", param: "logPath" });
    const symbolic = path.join(temp, "symbolic.log"); await fs.symlink(destination, symbolic);
    await assert.rejects(validateLogPath(symbolic), { code: "INVALID_CONFIG", param: "logPath" });
  }
});
test("log validation rejects a missing parent without creating a log or directory", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-missing-parent-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const missing = path.join(temp, "PRIVATE_MISSING_PARENT");
  await assert.rejects(validateLogPath(path.join(missing, "fixture.log")), error => {
    assert.equal(error.code, "INVALID_CONFIG"); assert.equal(error.param, "logPath");
    assert.equal(error.message.includes(missing), false); return true;
  });
  assert.deepEqual(await fs.readdir(temp), []);
});
test("Linux log validation rejects a read-only archive directory even with an appendable active log", {
  skip: process.platform !== "linux" || process.getuid() === 0,
}, async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-readonly-parent-"));
  t.after(async () => { await fs.chmod(temp, 0o700); await fs.rm(temp, { recursive: true, force: true }); });
  const destination = path.join(temp, "fixture.log");
  await fs.writeFile(destination, "preserve-me\n", { mode: 0o600 });
  await fs.chmod(temp, 0o500);
  await fs.access(destination, require("node:fs").constants.W_OK);
  await assert.rejects(validateLogPath(destination), { code: "INVALID_CONFIG", param: "logPath" });
  assert.equal(await fs.readFile(destination, "utf8"), "preserve-me\n");
  assert.deepEqual(await fs.readdir(temp), ["fixture.log"]);
});
test("logs roll to a dated archive when the local day changes", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-daily-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "bridge.log");
  let clock = new Date(2026, 9, 20, 23, 59, 0);
  const log = createLogger({ logPath: destination, stdout: null, now: () => clock });
  log("request", { outcome: "before-midnight" }); await log.flush();
  clock = new Date(2026, 9, 21, 0, 0, 5);
  log("request", { outcome: "after-midnight" }); await log.flush();
  const archived = await fs.readFile(path.join(temp, "bridge-2026-10-20.log"), "utf8");
  assert.ok(archived.includes("before-midnight")); assert.equal(archived.includes("after-midnight"), false);
  const active = await fs.readFile(destination, "utf8");
  assert.ok(active.includes("after-midnight")); assert.equal(active.includes("before-midnight"), false);
  log("shutdown", {}); await log.close();
});
test("archives older than the retention window are deleted, recent ones kept", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-retention-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "bridge.log");
  const stale = path.join(temp, "bridge-2026-10-01.log");
  const recent = path.join(temp, "bridge-2026-10-19.log");
  const legacy = path.join(temp, "bridge.log.old");
  const unrelated = path.join(temp, "notes-2020-01-01.log");
  for (const file of [stale, recent, legacy, unrelated]) await fs.writeFile(file, "{}\n");
  const now = new Date(2026, 9, 21, 12, 0, 0);
  const old = new Date(now.getTime() - 9 * 86_400_000);
  await fs.utimes(stale, old, old); await fs.utimes(legacy, old, old); await fs.utimes(unrelated, old, old);
  const log = createLogger({ logPath: destination, stdout: null, retentionDays: 7, now: () => now });
  log("request", { outcome: "trigger" }); await log.flush(); await log.close();
  const names = await fs.readdir(temp);
  assert.equal(names.includes("bridge-2026-10-01.log"), false, "stale archive should be deleted");
  assert.equal(names.includes("bridge.log.old"), false, "legacy rotation file should be deleted");
  assert.ok(names.includes("bridge-2026-10-19.log"), "recent archive should be kept");
  assert.ok(names.includes("notes-2020-01-01.log"), "unrelated files must never be deleted");
});
test("retention days are validated and can be configured", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-days-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const { validateConfig } = require("./config");
  const base = { azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"], azureApiKey: "fixture-upstream-key", proxyToken: "fixture-local-token",
    defaultModel: "local", models: { local: { deployment: "d", variant: "gpt-6-luna", version: "v" } } };
  assert.equal(validateConfig(base).logRetentionDays, 7);
  assert.equal(validateConfig({ ...base, logRetentionDays: 30 }).logRetentionDays, 30);
  for (const value of [0, -1, 1.5, "7", 3651]) assert.throws(() => validateConfig({ ...base, logRetentionDays: value }), /logRetentionDays/);
});
test("a record exceeding even a tiny log destination bound is dropped, not written", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-bound-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const destination = path.join(temp, "tiny.log");
  const log = createLogger({ logPath: destination, stdout: null, maxLogBytes: 1 });
  assert.equal(log("request", { status: 200 }), false);
  assert.equal(log("request", { status: 200 }), false);
  await log.close(); assert.equal(log.stats().dropped, 2);
  await assert.rejects(fs.stat(destination), { code: "ENOENT" });
});
test("known synthetic credential values cannot leak through permitted header fields", async () => {
  const lines = []; const log = createLogger({ stdout: { write(line) { lines.push(line); return true; }, off() {} }, secrets: ["synthetic-credential"] });
  log("request", { upstreamRequestId: "synthetic-credential", code: "prefix-synthetic-credential-suffix", outcome: "ok" });
  await log.close(); assert.ok(!lines.join("").includes("synthetic-credential"));
});
test("console failure does not crash the logger or disable its isolated file destination", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-log-console-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  class BrokenSink extends EventEmitter { write() { throw new Error("synthetic-private-error"); } }
  const sink = new BrokenSink(); const destination = path.join(temp, "fixture.log");
  const log = createLogger({ stdout: sink, logPath: destination });
  log("request", { outcome: "completed", finishReason: "stop" });
  sink.emit("error", new Error("synthetic-private-error"));
  log("shutdown", { outcome: "ok" }); await log.close();
  const lines = await fs.readFile(destination, "utf8");
  assert.ok(lines.includes("completed")); assert.ok(lines.includes("shutdown")); assert.ok(!lines.includes("synthetic-private-error"));
  assert.equal(sink.listenerCount("error"), 0);
});
test("console backpressure does not accumulate writes or drain listeners", async () => {
  class Sink extends EventEmitter { constructor() { super(); this.writes = 0; } write() { this.writes++; return false; } }
  const sink = new Sink(); const log = createLogger({ stdout: sink });
  for (let i = 0; i < 1000; i++) log("request", { status: 200 });
  assert.equal(sink.writes, 1); assert.equal(sink.listenerCount("drain"), 1);
  sink.emit("drain"); log("request", { status: 200 }); assert.equal(sink.writes, 2);
  await log.close(); assert.equal(sink.listenerCount("drain"), 0);
});
