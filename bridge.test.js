"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const path = require("node:path");
const vm = require("node:vm");

test("importing adapter and executable modules never loads env/logs or starts a server", () => {
  const effects = [];
  const originalRead = fs.readFileSync;
  const originalCreate = http.createServer;
  const originalHttpsCreate = https.createServer;
  const originalTlsContext = tls.createSecureContext;
  const originalLoad = process.loadEnvFile;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === "string" && /(?:^|[\\/])(?:\.env|bridge\.log)(?:$|\.)/.test(file)) { effects.push("filesystem"); throw new Error("Forbidden production file read"); }
    return originalRead.call(this, file, ...rest);
  };
  http.createServer = function () { effects.push("listener"); throw new Error("Import attempted server creation"); };
  https.createServer = function () { effects.push("tls_listener"); throw new Error("Import attempted HTTPS server creation"); };
  tls.createSecureContext = function () { effects.push("tls_context"); throw new Error("Import attempted TLS validation"); };
  process.loadEnvFile = () => { effects.push("environment"); throw new Error("Import attempted env loading"); };
  try {
    // Evaluate fresh modules, with the same main-module guard Node applies on import.
    for (const name of ["adapter.js", "config.js", "logger.js", "server.js", "bridge.js"]) {
      const filename = path.join(__dirname, name);
      const source = originalRead(filename, "utf8");
      const module = { exports: {} };
      const localRequire = specifier => require(specifier.startsWith(".") ? path.resolve(__dirname, specifier) : specifier);
      localRequire.main = require.main;
      vm.runInThisContext(`(function(require,module,exports,__dirname,__filename){${source}\n})`, { filename })(localRequire, module, module.exports, __dirname, filename);
      assert.ok(Object.keys(module.exports).length > 0);
    }
    assert.deepEqual(effects, []);
  } finally {
    fs.readFileSync = originalRead; http.createServer = originalCreate;
    https.createServer = originalHttpsCreate; tls.createSecureContext = originalTlsContext; process.loadEnvFile = originalLoad;
  }
});
test("CLI rejects ambiguous, malformed and unreadable explicit env selection privately", async t => {
  const { main } = require("./bridge");
  const temp = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "bridge-cli-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  for (const args of [
    ["--env-file"], ["--env-file", ""], ["--env-file", "   "], ["--env-file", "--check-config-json"],
    ["--env-file", "fixture\nsecret"], ["--env-file", "fixture\0secret"],
    ["--no-env-file", "--env-file", "fixture"], ["--env-file", "fixture", "--no-env-file"],
    ["--env-file", "fixture", "--env-file", "another"], ["--no-env-file", "--no-env-file"],
    ["--check-config-json", "--check-config-json"], ["--env-file=fixture"],
  ]) await assert.rejects(main(args, {}), { code: "INVALID_CONFIG", param: "cli" });
  for (const target of [path.join(temp, "PRIVATE_MISSING_MARKER"), temp]) {
    await assert.rejects(main(["--env-file", target, "--check-config-json"], {}), error => {
      assert.equal(error.code, "INVALID_CONFIG"); assert.equal(error.param, "envFile");
      assert.equal(error.message.includes(target), false); return true;
    });
  }
});

test("CLI console mode skips file validation and check-only validates TLS without runtime effects", async () => {
  const source = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
  for (const check of [false, true]) {
    const calls = []; const module = { exports: {} };
    const config = { logMode: "console", logPath: "PRIVATE_DESTINATION", timeouts: { shutdownMs: 1 } };
    const logger = () => {}; logger.close = async () => {};
    const server = { on() {}, listen() { calls.push("listen"); }, shutdown: async () => {} };
    const fakeProcess = { versions: process.versions, stdout: { write() { calls.push("summary"); } }, on() {}, off() {} };
    const mocks = {
      "./config": { loadConfig(options) { assert.equal(options.envFile, undefined); return config; } },
      "./logger": { async validateLogPath(value) { assert.equal(value, undefined); calls.push("log-validation"); },
        createLogger(options) { assert.equal(options.logPath, undefined); calls.push("logger"); return logger; } },
      "./adapter": {}, "./server": { createBridgeServer() { calls.push("server"); return server; },
        validateListenerTls(value) { assert.equal(value, config); calls.push("tls"); } },
    };
    const localRequire = name => mocks[name] || require(name);
    vm.runInThisContext(`(function(require,module,exports,__dirname,process){${source}\n})`)(localRequire, module, module.exports, __dirname, fakeProcess);
    await module.exports.main(check ? ["--no-env-file", "--check-config-json"] : ["--no-env-file"], {});
    assert.deepEqual(calls, check ? ["tls", "summary"] : ["tls", "log-validation", "logger", "server", "listen"]);
  }
});

test("check-only surfaces TLS verification errors without printing success or creating logs", async () => {
  const source = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
  const module = { exports: {} }; const calls = [];
  const mocks = {
    "./config": { loadConfig() { return {}; } }, "./adapter": {},
    "./logger": { createLogger() { calls.push("logger"); }, validateLogPath() { calls.push("log-validation"); } },
    "./server": { validateListenerTls() { throw Object.assign(new Error("Invalid listener TLS configuration"), { code: "INVALID_CONFIG", param: "tls" }); } },
  };
  const localRequire = name => mocks[name] || require(name);
  const fakeProcess = { versions: process.versions, stdout: { write() { calls.push("summary"); } } };
  vm.runInThisContext(`(function(require,module,exports,__dirname,process){${source}\n})`)(localRequire, module, module.exports, __dirname, fakeProcess);
  await assert.rejects(module.exports.main(["--no-env-file", "--check-config-json"], {}), { code: "INVALID_CONFIG", param: "tls" });
  assert.deepEqual(calls, []);
});

test("default missing dotenv remains optional but explicitly selected dotenv is required", async () => {
  const source = fs.readFileSync(path.join(__dirname, "bridge.js"), "utf8");
  const module = { exports: {} }; const calls = [];
  const localRequire = name => {
    if (name === "node:fs") return { statSync() { throw Object.assign(new Error("private fixture"), { code: "ENOENT" }); }, constants: { R_OK: 4 } };
    if (name === "./config") return { loadConfig({ envFile }) { calls.push(envFile); return {}; } };
    if (name === "./server") return { validateListenerTls() {} };
    if (name === "./logger" || name === "./adapter") return {};
    return require(name);
  };
  const fakeProcess = { versions: process.versions, stdout: { write() {} } };
  vm.runInThisContext(`(function(require,module,exports,__dirname,process){${source}\n})`)(localRequire, module, module.exports, __dirname, fakeProcess);
  await module.exports.main(["--check-config-json"], {});
  assert.equal(calls[0], path.join(__dirname, ".env"));
  await assert.rejects(module.exports.main(["--env-file", "fixture", "--check-config-json"], {}), { code: "INVALID_CONFIG", param: "envFile" });
  assert.equal(calls.length, 1);
});

test("entrypoint diagnostics use isolated env and expose no sensitive configuration", async () => {
  const { main } = require("./bridge");
  const isolatedEnv = { AZURE_OPENAI_BASE: "https://example.invalid", BRIDGE_APPROVED_ORIGINS: '["https://example.invalid"]',
    AZURE_OPENAI_API_KEY: "synthetic-upstream-marker", BRIDGE_PROXY_TOKEN: "synthetic-local-marker", BRIDGE_MODEL_ALIAS: "fixture-alias",
    AZURE_OPENAI_MODEL: "deployment", AZURE_OPENAI_VARIANT: "gpt-6-luna", AZURE_OPENAI_VERSION: "fixture" };
  const originalWrite = process.stdout.write; const output = [];
  process.stdout.write = text => { output.push(String(text)); return true; };
  try { await main(["--no-env-file", "--check-config-json"], isolatedEnv); }
  finally { process.stdout.write = originalWrite; }
  const body = output.join(""); const diagnostic = JSON.parse(body);
  assert.equal(diagnostic.service, "azure-responses-bridge"); assert.equal(diagnostic.protocol, "chat-to-responses-v1");
  assert.equal(diagnostic.status, "configured"); assert.equal(diagnostic.port, 8787); assert.equal(diagnostic.transport, "http");
  const { safeConfigSummary } = require("./bridge");
  const tlsSummary = safeConfigSummary({ tlsCert: "PRIVATE_CERT_PATH", tlsKey: "PRIVATE_KEY_PATH" });
  assert.equal(tlsSummary.transport, "https"); assert.equal(JSON.stringify(tlsSummary).includes("PRIVATE_"), false);
  assert.ok(!body.includes("synthetic-")); assert.ok(!body.includes("deployment"));
  await assert.rejects(main(["--unknown"], isolatedEnv), { code: "INVALID_CONFIG" });
  await assert.rejects(main(["--no-env-file", "--check-config-json"], {}), { code: "INVALID_CONFIG" });
});
