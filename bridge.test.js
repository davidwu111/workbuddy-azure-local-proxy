"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const vm = require("node:vm");

test("importing adapter and executable modules never loads env/logs or starts a server", () => {
  const effects = [];
  const originalRead = fs.readFileSync;
  const originalCreate = http.createServer;
  const originalLoad = process.loadEnvFile;
  fs.readFileSync = function (file, ...rest) {
    if (typeof file === "string" && /(?:^|[\\/])(?:\.env|bridge\.log)(?:$|\.)/.test(file)) { effects.push("filesystem"); throw new Error("Forbidden production file read"); }
    return originalRead.call(this, file, ...rest);
  };
  http.createServer = function () { effects.push("listener"); throw new Error("Import attempted server creation"); };
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
  } finally { fs.readFileSync = originalRead; http.createServer = originalCreate; process.loadEnvFile = originalLoad; }
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
  assert.equal(diagnostic.status, "configured"); assert.equal(diagnostic.port, 8787);
  assert.ok(!body.includes("synthetic-")); assert.ok(!body.includes("deployment"));
  await assert.rejects(main(["--unknown"], isolatedEnv), { code: "INVALID_CONFIG" });
  await assert.rejects(main(["--no-env-file", "--check-config-json"], {}), { code: "INVALID_CONFIG" });
});
