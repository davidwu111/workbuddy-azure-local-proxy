"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { validateConfig, loadConfig, parseEnvironment, capabilityProfile } = require("./config");
function raw(overrides = {}) { return { azureBase: "https://example.invalid", approvedOrigins: ["https://example.invalid"],
  azureApiKey: "fixture-upstream", proxyToken: "fixture-local", defaultModel: "local", models: {
    local: { deployment: "arbitrary-deployment", variant: "gpt-6-luna", version: "fixture-version" } }, ...overrides }; }
function env(overrides = {}) { return { AZURE_OPENAI_BASE: "https://example.invalid", BRIDGE_APPROVED_ORIGINS: '["https://example.invalid"]',
  AZURE_OPENAI_API_KEY: "fixture-upstream", BRIDGE_PROXY_TOKEN: "fixture-local", BRIDGE_MODEL_ALIAS: "local",
  AZURE_OPENAI_MODEL: "opaque-deployment", AZURE_OPENAI_VARIANT: "gpt-6-luna", AZURE_OPENAI_VERSION: "fixture-version", ...overrides }; }
test("startup requires explicit origins, deployment, variant/version, separate auth and safe default binding", () => {
  const c = validateConfig(raw()); assert.equal(c.host, "127.0.0.1"); assert.equal(c.defaults.store, false);
  assert.equal(c.models.local.profile.images, false); assert.equal(c.models.local.profile.defaultEffort, undefined);
  for (const change of [{ approvedOrigins: [] }, { azureBase: "http://example.invalid" }, { azureBase: "https://example.invalid/openai" },
    { azureBase: "https://user:pass@example.invalid" }, { azureBase: "https://example.invalid/?q=1" }, { proxyToken: "fixture-upstream" },
    { host: "localhost" }, { proxyToken: "fixture local" }, { proxyToken: " fixture-local " }, { proxyToken: "non-ascii-令牌" },
    { models: { local: { deployment: "gpt-6-luna", variant: "gpt-5", version: "v" } } },
    { models: { local: { deployment: "some-gpt-6-name", variant: undefined, version: "v" } } },
    { models: { local: { deployment: "x", variant: "gpt-6-luna" } } }, { defaultModel: "unknown" }]) {
    assert.throws(() => validateConfig(raw(change)), { code: "INVALID_CONFIG" });
  }
});
test("invalid ports, budgets, limit/timeouts and JSON fail before listening", () => {
  for (const port of [0, -1, 65536, 1.5, NaN, "8787"]) assert.throws(() => validateConfig(raw({ port })), /port/);
  for (const BRIDGE_PORT of ["0", "-1", "1.5", "8787oops", "", "65536"]) assert.throws(() => loadConfig({ env: env({ BRIDGE_PORT }) }), /port|BRIDGE_PORT/);
  assert.equal(loadConfig({ env: env({ BRIDGE_PORT: " 8888 " }) }).port, 8888);
  for (const limits of [{ requestBytes: 0 }, { unknown: 1 }, { maxConcurrent: 129 }]) assert.throws(() => validateConfig(raw({ limits })), /limits/);
  assert.throws(() => validateConfig(raw({ timeouts: { uploadMs: "100" } })), /timeouts/);
  assert.throws(() => loadConfig({ env: env({ BRIDGE_MODELS: "{" }) }), /BRIDGE_MODELS/);
  assert.throws(() => loadConfig({ env: env({ BRIDGE_ALLOW_STORE: "yes" }) }), /BRIDGE_ALLOW_STORE/);
});
test("Node dotenv grammar and explicit environment precedence are shared", async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-config-test-"));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const file = path.join(temp, "fixture.env");
  await fs.writeFile(file, 'export BRIDGE_PORT = " 9898 " # comment\nAZURE_OPENAI_MODEL="deployment-from-file"\n');
  assert.equal(parseEnvironment('export BRIDGE_PORT=" 7777 "\nBRIDGE_PORT=8888', {}).BRIDGE_PORT, "8888");
  assert.equal(loadConfig({ env: env(), envFile: file }).port, 9898);
  const c = loadConfig({ env: env({ BRIDGE_PORT: "7777" }), envFile: file });
  assert.equal(c.port, 7777); assert.equal(c.models.local.deployment, "opaque-deployment");
  // envFile is explicit; loadConfig({env}) never loads the repository production environment.
  assert.equal(loadConfig({ env: env() }).port, 8787);
});
test("routing and profile overrides never infer a variant from deployment", () => {
  const c = loadConfig({ env: env({ BRIDGE_MODELS: JSON.stringify({ local: { deployment: "banana", variant: "gpt-6-sol", version: "test" },
    second: { deployment: "anything", variant: "gpt-6-astra", version: "test" } }) }) });
  assert.equal(c.models.local.deployment, "banana"); assert.ok(c.models.local.profile.efforts.includes("none"));
  assert.ok(!c.models.second.profile.efforts.includes("none"));
  assert.throws(() => capabilityProfile("gpt-6-astra", { efforts: ["none"] }), /efforts/);
  assert.throws(() => capabilityProfile("gpt-6-luna", { maxOutputTokens: 128001 }), /maxOutputTokens/);
  assert.equal(capabilityProfile("gpt-6-luna", { deploymentType: "ptu-m" }).cacheBreakpoints, false);
  assert.throws(() => capabilityProfile("gpt-6-luna", { deploymentType: "ptu-m", cacheBreakpoints: true }), /PTU-M/);
  assert.throws(() => validateConfig(raw({ defaults: { reasoningMode: "pro" } })), /reasoningMode/);
  assert.equal(validateConfig(raw({ models: { local: { deployment: "d", variant: "gpt-6-luna", version: "v", profile: { reasoningModes: ["standard", "pro"] } } },
    defaults: { reasoningMode: "pro" } })).defaults.reasoningMode, "pro");
});
test("client metadata extension list is bounded and cannot claim reserved message fields", () => {
  const c = validateConfig(raw());
  assert.deepEqual(c.clientMetadataFields, ["startsNewUserRequest", "agent", "conversationRequestId"]);
  const extended = validateConfig(raw({ clientMetadataFields: ["conversationRequestId", "agent"] }));
  assert.deepEqual(extended.clientMetadataFields, ["conversationRequestId", "agent"]);
  assert.equal(validateConfig(raw({ clientMetadataFields: [] })).clientMetadataFields.length, 0);
  for (const fields of [["content"], ["tool_calls"], ["tool_call_id"], ["role"], ["name"], ["audio"], ["function_call"], ["reasoning_content"], ["phase"], ["with.dot"], ["with[bracket]"], [""], ["1leading"], ["x".repeat(65)], ["a", "a"], new Array(17).fill("a").map((v, i) => `f${i}`), "agent", [1]]) {
    assert.throws(() => validateConfig(raw({ clientMetadataFields: fields })), /clientMetadataFields/, `accepted ${JSON.stringify(fields)}`);
  }
  assert.throws(() => loadConfig({ env: env({ BRIDGE_CLIENT_METADATA_FIELDS: "not-json" }) }), /BRIDGE_CLIENT_METADATA_FIELDS/);
  assert.deepEqual(loadConfig({ env: env({ BRIDGE_CLIENT_METADATA_FIELDS: '["agent","conversationRequestId"]' }) }).clientMetadataFields, ["agent", "conversationRequestId"]);
  assert.notEqual(validateConfig(raw()).configId, validateConfig(raw({ clientMetadataFields: ["agent"] })).configId);
});

test("client metadata mode controls only how unknown message keys are treated", () => {
  assert.equal(validateConfig(raw()).clientMetadataMode, "auto");
  assert.equal(validateConfig(raw({ clientMetadataMode: "strict" })).clientMetadataMode, "strict");
  assert.equal(loadConfig({ env: env({ BRIDGE_CLIENT_METADATA_MODE: "strict" }) }).clientMetadataMode, "strict");
  for (const mode of ["permissive", "", true]) assert.throws(() => validateConfig(raw({ clientMetadataMode: mode })), /clientMetadataMode/);
  assert.equal(validateConfig(raw({ clientMetadataMode: null })).clientMetadataMode, "auto");
  assert.notEqual(validateConfig(raw()).configId, validateConfig(raw({ clientMetadataMode: "strict" })).configId);
});

test("storage cache defaults and diagnostic identity are safe and deliberate", () => {
  assert.throws(() => validateConfig(raw({ defaults: { store: true } })), /allowStore/);
  assert.equal(validateConfig(raw({ allowStore: true, defaults: { store: true } })).defaults.store, true);
  for (const cacheOptions of [{ mode: "automatic" }, { ttl: "24h" }, { extra: true }]) assert.throws(() => validateConfig(raw({ defaults: { cacheOptions } })), /cacheOptions/);
  for (const cacheKey of [123, true, null, "private key with spaces"]) assert.throws(() => validateConfig(raw({ defaults: { cacheKey } })), /cacheKey/);
  assert.throws(() => validateConfig(raw({ models: { local: { deployment: "d", variant: "gpt-6-luna", version: "v", profile: { deploymentType: "ptu-m" } } },
    defaults: { cacheOptions: { mode: "explicit" } } })), /PTU-M/);
  assert.equal(validateConfig(raw()).configId, validateConfig(raw({ azureApiKey: "different-upstream", proxyToken: "different-local" })).configId);
  assert.notEqual(validateConfig(raw()).configId, validateConfig(raw({ samplingPolicy: "drop-defaults" })).configId);
});
test("localhost HTTP requires an explicit isolated seam", () => {
  const mock = raw({ azureBase: "http://127.0.0.1:1234", approvedOrigins: ["http://127.0.0.1:1234"] });
  assert.throws(() => validateConfig(mock), /HTTPS/);
  assert.equal(validateConfig(mock, { allowHttpLocalhostForTests: true }).azureBase, "http://127.0.0.1:1234");
  assert.throws(() => validateConfig(raw({ azureBase: "http://localhost:1234", approvedOrigins: ["http://localhost:1234"] }), { allowHttpLocalhostForTests: true }), /HTTPS/);
});
test("Linux listener accepts explicit literal IPs, paired TLS paths and private listener identity", () => {
  for (const host of ["127.0.0.1", "127.0.0.2", "192.168.1.10", "0.0.0.0", "::1", "::"]) {
    assert.equal(validateConfig(raw({ host })).host, host);
    assert.equal(loadConfig({ env: env({ BRIDGE_HOST: host }) }).host, host);
  }
  for (const host of ["", "localhost", "https://127.0.0.1", "127.0.0.1:8787", "[::1]", " 127.0.0.1 ", 123, "999.1.1.1"]) {
    assert.throws(() => validateConfig(raw({ host })), { code: "INVALID_CONFIG", param: "host" });
  }
  for (const tls of [{ tlsCert: "cert.pem" }, { tlsKey: "key.pem" }, { tlsCert: "cert.pem", tlsKey: "" }]) {
    assert.throws(() => validateConfig(raw(tls)), { code: "INVALID_CONFIG", param: "tls" });
  }
  const c = loadConfig({ env: env({ BRIDGE_TLS_CERT: "fixture cert.pem", BRIDGE_TLS_KEY: "fixture key.pem" }) });
  assert.equal(c.tlsCert, path.resolve("fixture cert.pem"));
  assert.equal(c.tlsKey, path.resolve("fixture key.pem"));
  assert.equal(validateConfig(c).configId, c.configId, "factory revalidation remains stable");
  assert.notEqual(validateConfig(raw()).configId, c.configId);
  assert.notEqual(validateConfig(raw()).configId, validateConfig(raw({ host: "127.0.0.2" })).configId);
  assert.notEqual(validateConfig(raw()).configId, validateConfig(raw({ port: 8788 })).configId);
  assert.equal(c.configId, validateConfig({ ...c, tlsCert: "other cert.pem", tlsKey: "other key.pem" }).configId, "TLS paths/material never enter public identity; restart explicitly");
});
test("file and console log modes preserve legacy journald without rotating device files", () => {
  assert.equal(validateConfig(raw()).logMode, "file");
  for (const overrides of [{ BRIDGE_LOG_MODE: "console" }, { BRIDGE_LOG_PATH: "/dev/null" }]) {
    const c = loadConfig({ env: env(overrides) });
    assert.equal(c.logMode, "console"); assert.equal(c.logPath, undefined);
    assert.equal(validateConfig(c).logMode, "console");
  }
  assert.equal(loadConfig({ env: env({ BRIDGE_LOG_MODE: "file", BRIDGE_LOG_PATH: "private.log" }) }).logPath, "private.log");
  assert.throws(() => loadConfig({ env: env({ BRIDGE_LOG_MODE: "none" }) }), /logMode/);
  assert.equal(validateConfig(raw()).configId, validateConfig(raw({ logMode: "console" })).configId);
});
module.exports = { raw, env };
