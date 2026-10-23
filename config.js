"use strict";

// No environment reads, filesystem operations, or startup on import.
const { parseEnv } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { isIP } = require("node:net");
const { WORKBUDDY_MESSAGE_FIELDS, CLIENT_METADATA_MODES, validateClientMetadataFieldName } = require("./chat-contract");
const { normalizeNativePolicies } = require("./native-permissions");
const VARIANTS = Object.freeze(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-6.1-sol"]);
const EFFORTS = ["none", "low", "medium", "high", "xhigh", "max"];
const LIMIT_DEFAULTS = Object.freeze({ requestBytes: 8 * 1024 ** 2, jsonBytes: 32 * 1024 ** 2,
  errorBytes: 64 * 1024, sseLineBytes: 16 * 1024 ** 2, sseEventBytes: 16 * 1024 ** 2,
  sseBufferBytes: 16 * 1024 ** 2, responseBytes: 64 * 1024 ** 2, maxConcurrent: 16, maxQueue: 32 });
const TIMEOUT_DEFAULTS = Object.freeze({ uploadMs: 30000, upstreamIdleMs: 300000,
  downstreamStallMs: 30000, totalMs: 1800000, shutdownMs: 5000, capacityWaitMs: 30000 });
function fail(param, message) { const e = new Error(`${param}: ${message}`); e.code = "INVALID_CONFIG"; e.param = param; throw e; }
function object(value, param) { if (!value || typeof value !== "object" || Array.isArray(value)) fail(param, "must be an object"); return value; }
function keys(value, allowed, param) { for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${param}.${key}`, "unsupported setting"); }
function nonempty(value, param, max = 256) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/.test(value)) fail(param, "must be a nonempty bounded string");
  return value.trim();
}
function positive(value, param, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) fail(param, `must be an integer from 1 to ${max}`);
  return value;
}
function enumValue(value, choices, param) { if (!choices.includes(value)) fail(param, `must be one of ${choices.join(", ")}`); return value; }
function list(value, choices, param) {
  if (!Array.isArray(value) || new Set(value).size !== value.length || value.some(x => !choices.includes(x))) fail(param, "must be a unique array of supported values");
  return [...value];
}
function bool(value, param) { if (typeof value !== "boolean") fail(param, "must be a boolean"); return value; }
function validateOrigin(value, param, allowHttpLocalhostForTests = false) {
  let url; try { url = new URL(value); } catch { fail(param, "must be an absolute origin"); }
  const mock = allowHttpLocalhostForTests && url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((!mock && url.protocol !== "https:") || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail(param, "must be an HTTPS origin without credentials, path, query or fragment");
  return url.origin;
}
function validateCacheOptions(value, param) {
  object(value, param); keys(value, ["mode", "ttl"], param);
  const out = {};
  if (value.mode !== undefined) out.mode = enumValue(value.mode, ["implicit", "explicit"], `${param}.mode`);
  if (value.ttl !== undefined) out.ttl = enumValue(value.ttl, ["30m"], `${param}.ttl`);
  return out;
}
function capabilityProfile(variant, overrides = {}, param = "profile") {
  enumValue(variant, VARIANTS, "variant"); object(overrides, param);
  const base = { efforts: variant === "gpt-6-sol" || variant === "gpt-6-luna" ? [...EFFORTS] : EFFORTS.slice(1),
    samplingEfforts: variant === "gpt-6-sol" || variant === "gpt-6-luna" ? ["none"] : [],
    maxOutputTokens: 128000, images: false, verbosity: true, cacheBreakpoints: true,
    reasoningModes: ["standard"], reasoningContexts: ["auto", "current_turn", "all_turns"], deploymentType: "payg" };
  keys(overrides, [...Object.keys(base), "defaultEffort"], param);
  const p = { ...base, ...overrides };
  p.efforts = list(p.efforts, base.efforts, `${param}.efforts`);
  if (!p.efforts.length) fail(`${param}.efforts`, "cannot be empty");
  // Expansion of disputed sampling/mode support is an operator assertion, not automatic model-name detection.
  p.samplingEfforts = list(p.samplingEfforts, p.efforts, `${param}.samplingEfforts`);
  if (p.defaultEffort !== undefined) enumValue(p.defaultEffort, p.efforts, `${param}.defaultEffort`);
  p.reasoningModes = list(p.reasoningModes, ["standard", "pro"], `${param}.reasoningModes`);
  p.reasoningContexts = list(p.reasoningContexts, ["auto", "current_turn", "all_turns"], `${param}.reasoningContexts`);
  positive(p.maxOutputTokens, `${param}.maxOutputTokens`, 128000);
  for (const name of ["images", "verbosity", "cacheBreakpoints"]) bool(p[name], `${param}.${name}`);
  enumValue(p.deploymentType, ["payg", "ptu-m"], `${param}.deploymentType`);
  if (p.deploymentType === "ptu-m") {
    if (overrides.cacheBreakpoints === true) fail(`${param}.cacheBreakpoints`, "PTU-M does not support explicit breakpoints");
    p.cacheBreakpoints = false;
  }
  return p;
}
function validateConfig(raw, { allowHttpLocalhostForTests = false } = {}) {
  object(raw, "config");
  const config = { ...raw, host: raw.host ?? "127.0.0.1" };
  if (typeof config.host !== "string" || !isIP(config.host)) fail("host", "must be a literal IPv4 or IPv6 address");
  config.port = positive(raw.port ?? 8787, "port", 65535);
  // File contents are read only at explicit listener/check startup, never on import.
  const tlsPath = (value, param) => value === undefined || value === "" ? undefined : path.resolve(nonempty(value, param, 32768));
  config.tlsCert = tlsPath(raw.tlsCert, "tlsCert");
  config.tlsKey = tlsPath(raw.tlsKey, "tlsKey");
  if (Boolean(config.tlsCert) !== Boolean(config.tlsKey)) fail("tls", "both certificate and key paths are required");
  config.azureBase = validateOrigin(raw.azureBase, "azureBase", allowHttpLocalhostForTests);
  if (!Array.isArray(raw.approvedOrigins) || !raw.approvedOrigins.length) fail("approvedOrigins", "an explicitly approved origin allowlist is required");
  config.approvedOrigins = raw.approvedOrigins.map((origin, i) => validateOrigin(origin, `approvedOrigins[${i}]`, allowHttpLocalhostForTests));
  if (!config.approvedOrigins.includes(config.azureBase)) fail("azureBase", "origin is not explicitly approved");
  config.azureApiKey = nonempty(raw.azureApiKey, "azureApiKey", 8192);
  config.proxyToken = nonempty(raw.proxyToken, "proxyToken", 8192);
  if (raw.proxyToken !== config.proxyToken || !/^[\x21-\x7e]+$/.test(config.proxyToken)) fail("proxyToken", "must contain visible ASCII characters without whitespace");
  if (config.azureApiKey === config.proxyToken) fail("proxyToken", "local bearer must differ from Azure credential");
  object(raw.models, "models");
  const entries = Object.entries(raw.models);
  if (!entries.length || entries.length > 32) fail("models", "requires 1 to 32 explicit routes");
  config.models = Object.create(null);
  for (const [alias, route] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(alias) || ["__proto__", "constructor", "prototype"].includes(alias)) fail("models", "invalid alias");
    object(route, `models.${alias}`); keys(route, ["deployment", "variant", "version", "profile"], `models.${alias}`);
    const variant = enumValue(route.variant, VARIANTS, `models.${alias}.variant`);
    const deployment = nonempty(route.deployment, `models.${alias}.deployment`, 128);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(deployment)) fail(`models.${alias}.deployment`, "invalid deployment identifier");
    config.models[alias] = { deployment, variant, version: nonempty(route.version, `models.${alias}.version`, 128),
      profile: capabilityProfile(variant, route.profile, `models.${alias}.profile`) };
  }
  config.defaultModel = nonempty(raw.defaultModel, "defaultModel", 128);
  if (!Object.hasOwn(config.models, config.defaultModel)) fail("defaultModel", "must identify a permitted alias");
  config.nativePolicies = normalizeNativePolicies(raw.nativePolicies ?? Object.create(null), Object.keys(config.models));
  // Chat gates images on the route profile while native gates them on the policy grant; both must agree.
  for (const alias of Object.keys(config.models)) {
    if (config.nativePolicies[alias].features.includes("image-input") && config.models[alias].profile.images !== true) fail(`nativePolicies.${alias}.features`, "image-input requires profile.images=true for the same alias");
  }
  config.maxOutputTokens = positive(raw.maxOutputTokens ?? 128000, "maxOutputTokens", 128000);
  // Clients that omit a budget inherit the ceiling unless the operator sets a separate default.
  config.defaultMaxOutputTokens = positive(raw.defaultMaxOutputTokens ?? config.maxOutputTokens, "defaultMaxOutputTokens", 128000);
  if (config.defaultMaxOutputTokens > config.maxOutputTokens) fail("defaultMaxOutputTokens", "must not exceed maxOutputTokens");
  config.instructionPolicy = enumValue(raw.instructionPolicy ?? "reject-mixed", ["preserve", "developer", "system", "reject-mixed"], "instructionPolicy");
  config.samplingPolicy = enumValue(raw.samplingPolicy ?? "reject", ["reject", "drop-defaults"], "samplingPolicy");
  config.allowStore = bool(raw.allowStore ?? false, "allowStore");
  config.nativeResponses = bool(raw.nativeResponses ?? false, "nativeResponses");
  if (raw.clientMetadataFields !== undefined) {
    if (!Array.isArray(raw.clientMetadataFields) || raw.clientMetadataFields.length > 16) fail("clientMetadataFields", "must be an array of at most 16 field names");
    config.clientMetadataFields = [];
    for (const [index, name] of raw.clientMetadataFields.entries()) {
      const problem = validateClientMetadataFieldName(name);
      if (problem) fail(`clientMetadataFields[${index}]`, problem);
      if (config.clientMetadataFields.includes(name)) fail(`clientMetadataFields[${index}]`, "duplicate field name");
      config.clientMetadataFields.push(name);
    }
  } else {
    config.clientMetadataFields = [...WORKBUDDY_MESSAGE_FIELDS];
  }
  // "strict" accepts only the listed message metadata. "auto" additionally
  // ignores any other non-standard message-level key after bounded validation;
  // reserved/standard message fields and unknown top-level fields still fail.
  config.clientMetadataMode = enumValue(raw.clientMetadataMode ?? "auto", CLIENT_METADATA_MODES, "clientMetadataMode");
  config.defaults = { store: false, ...object(raw.defaults ?? {}, "defaults") };
  keys(config.defaults, ["store", "reasoningEffort", "reasoningMode", "reasoningContext", "cacheKey", "cacheOptions"], "defaults");
  bool(config.defaults.store, "defaults.store");
  if (config.defaults.store && !config.allowStore) fail("defaults.store", "requires allowStore opt-in");
  if (config.defaults.cacheKey !== undefined && (typeof config.defaults.cacheKey !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(config.defaults.cacheKey))) fail("defaults.cacheKey", "use a non-secret prefix-family identifier (1-128 ASCII characters)");
  if (config.defaults.cacheOptions !== undefined) config.defaults.cacheOptions = validateCacheOptions(config.defaults.cacheOptions, "defaults.cacheOptions");
  for (const route of Object.values(config.models)) {
    for (const [name, supported] of [["reasoningEffort", "efforts"], ["reasoningMode", "reasoningModes"], ["reasoningContext", "reasoningContexts"]]) {
      if (config.defaults[name] !== undefined) enumValue(config.defaults[name], route.profile[supported], `defaults.${name}`);
    }
    if (route.profile.deploymentType === "ptu-m" && config.defaults.cacheOptions?.mode === "explicit") fail("defaults.cacheOptions.mode", "explicit cache policy cannot disable PTU-M caching");
  }
  config.limits = { ...LIMIT_DEFAULTS, ...object(raw.limits ?? {}, "limits") };
  keys(config.limits, Object.keys(LIMIT_DEFAULTS), "limits");
  for (const [key, value] of Object.entries(config.limits)) {
    // maxQueue may be zero, meaning "reject immediately instead of waiting".
    if (key === "maxQueue") { if (!Number.isSafeInteger(value) || value < 0 || value > 1024) fail("limits.maxQueue", "must be an integer from 0 to 1024"); continue; }
    positive(value, `limits.${key}`, key === "maxConcurrent" ? 128 : 512 * 1024 ** 2);
  }
  config.timeouts = { ...TIMEOUT_DEFAULTS, ...object(raw.timeouts ?? {}, "timeouts") };
  keys(config.timeouts, Object.keys(TIMEOUT_DEFAULTS), "timeouts");
  for (const [key, value] of Object.entries(config.timeouts)) positive(value, `timeouts.${key}`, 86400000);
  // Retain old systemd /dev/null configuration as console-only, never rotate devices.
  config.logMode = enumValue(raw.logMode ?? (raw.logPath === "/dev/null" ? "console" : "file"), ["file", "console"], "logMode");
  config.logPath = config.logMode === "console" ? undefined : raw.logPath === undefined ? path.join(__dirname, "bridge.log") : nonempty(raw.logPath, "logPath", 32768);
  config.maxLogBytes = positive(raw.maxLogBytes ?? 10 * 1024 ** 2, "maxLogBytes", 512 * 1024 ** 2);
  config.logRetentionDays = positive(raw.logRetentionDays ?? 7, "logRetentionDays", 3650);
  // Never hash credential material into publicly visible identity.
  config.configId = crypto.createHash("sha256").update(JSON.stringify({ host: config.host, port: config.port, tls: Boolean(config.tlsCert), models: config.models, defaultModel: config.defaultModel,
    azureBase: config.azureBase, maxOutputTokens: config.maxOutputTokens, defaultMaxOutputTokens: config.defaultMaxOutputTokens, instructionPolicy: config.instructionPolicy,
    samplingPolicy: config.samplingPolicy, allowStore: config.allowStore, nativeResponses: config.nativeResponses, defaults: config.defaults,
    clientMetadataFields: config.clientMetadataFields, clientMetadataMode: config.clientMetadataMode, nativePolicies: config.nativePolicies,
    limits: config.limits, timeouts: config.timeouts })).digest("hex").slice(0, 16);
  return config;
}
function jsonEnv(env, name, fallback) {
  if (env[name] === undefined) return fallback;
  try { return JSON.parse(env[name]); } catch { fail(name, "must be valid JSON"); }
}
function integerEnv(env, name, fallback) {
  if (env[name] === undefined) return fallback;
  const value = String(env[name]).trim();
  if (!/^\d+$/.test(value)) fail(name, "must be a decimal integer");
  return Number(value);
}
function booleanEnv(env, name, fallback) {
  if (env[name] === undefined) return fallback;
  if (!["true", "false"].includes(env[name])) fail(name, "must be true or false");
  return env[name] === "true";
}
function parseEnvironment(text, env = {}) { return { ...parseEnv(text), ...env }; }
function loadConfig({ env = process.env, envFile, allowHttpLocalhostForTests = false } = {}) {
  let merged = { ...env };
  if (envFile !== undefined) {
    let text = "";
    try { text = fs.readFileSync(envFile, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    merged = parseEnvironment(text, env);
  }
  const defaultModel = merged.BRIDGE_MODEL_ALIAS ?? "gpt-6-local";
  const models = jsonEnv(merged, "BRIDGE_MODELS", { [defaultModel]: {
    deployment: merged.AZURE_OPENAI_MODEL, variant: merged.AZURE_OPENAI_VARIANT, version: merged.AZURE_OPENAI_VERSION,
    profile: jsonEnv(merged, "BRIDGE_MODEL_PROFILE", {}) } });
  const defaults = { store: booleanEnv(merged, "BRIDGE_STORE_DEFAULT", false) };
  for (const [key, name] of Object.entries({ reasoningEffort: "BRIDGE_REASONING_EFFORT", reasoningMode: "BRIDGE_REASONING_MODE",
    reasoningContext: "BRIDGE_REASONING_CONTEXT", cacheKey: "BRIDGE_PROMPT_CACHE_KEY" })) if (merged[name] !== undefined) defaults[key] = merged[name];
  if (merged.BRIDGE_PROMPT_CACHE_OPTIONS !== undefined) defaults.cacheOptions = jsonEnv(merged, "BRIDGE_PROMPT_CACHE_OPTIONS");
  return validateConfig({ host: merged.BRIDGE_HOST ?? "127.0.0.1", port: integerEnv(merged, "BRIDGE_PORT", 8787),
    tlsCert: merged.BRIDGE_TLS_CERT, tlsKey: merged.BRIDGE_TLS_KEY, logMode: merged.BRIDGE_LOG_MODE,
    azureBase: merged.AZURE_OPENAI_BASE, approvedOrigins: jsonEnv(merged, "BRIDGE_APPROVED_ORIGINS", []),
    azureApiKey: merged.AZURE_OPENAI_API_KEY, proxyToken: merged.BRIDGE_PROXY_TOKEN, models, defaultModel,
    maxOutputTokens: integerEnv(merged, "BRIDGE_MAX_OUTPUT_TOKENS", 128000),
    defaultMaxOutputTokens: integerEnv(merged, "BRIDGE_DEFAULT_MAX_OUTPUT_TOKENS", undefined),
    instructionPolicy: merged.BRIDGE_INSTRUCTION_POLICY ?? "reject-mixed", samplingPolicy: merged.BRIDGE_SAMPLING_POLICY ?? "reject",
    allowStore: booleanEnv(merged, "BRIDGE_ALLOW_STORE", false), nativeResponses: booleanEnv(merged, "BRIDGE_NATIVE_RESPONSES", false), defaults,
     nativePolicies: jsonEnv(merged, "BRIDGE_NATIVE_POLICIES", {}),
    clientMetadataFields: jsonEnv(merged, "BRIDGE_CLIENT_METADATA_FIELDS", undefined),
    clientMetadataMode: merged.BRIDGE_CLIENT_METADATA_MODE ?? "auto",
    limits: jsonEnv(merged, "BRIDGE_LIMITS", {}), timeouts: jsonEnv(merged, "BRIDGE_TIMEOUTS", {}),
    logPath: merged.BRIDGE_LOG_PATH, maxLogBytes: integerEnv(merged, "BRIDGE_MAX_LOG_BYTES", 10 * 1024 ** 2),
    logRetentionDays: integerEnv(merged, "BRIDGE_LOG_RETENTION_DAYS", 7) }, { allowHttpLocalhostForTests });
}
module.exports = { VARIANTS, LIMIT_DEFAULTS, TIMEOUT_DEFAULTS, capabilityProfile, validateConfig, loadConfig, parseEnvironment, validateOrigin, WORKBUDDY_MESSAGE_FIELDS };
