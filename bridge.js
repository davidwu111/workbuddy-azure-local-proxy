"use strict";

// The executable boundary is the only place that loads .env or opens a log/listener.
const path = require("node:path");
const fs = require("node:fs");
const { loadConfig } = require("./config");
const { createLogger, validateLogPath } = require("./logger");
const adapter = require("./adapter");
const { createBridgeServer, validateListenerTls, SERVICE, PROTOCOL, BUILD } = require("./server");

function safeConfigSummary(config) {
  return { service: SERVICE, protocol: PROTOCOL, build: BUILD, configId: config.configId,
    host: config.host, port: config.port, transport: config.tlsCert ? "https" : "http", status: "configured" };
}
async function main(args = process.argv.slice(2), env = process.env) {
  let envFile = path.join(__dirname, ".env");
  let check = false, envSelection = false, explicitEnvFile = false;
  const invalidOption = () => { throw Object.assign(new Error("Invalid command-line options"), { code: "INVALID_CONFIG", param: "cli" }); };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check-config-json") {
      if (check) invalidOption();
      check = true;
    } else if (args[i] === "--env-file") {
      const value = args[i + 1];
      if (envSelection || typeof value !== "string" || !value.trim() || value.startsWith("--") || /[\0\r\n]/.test(value)) invalidOption();
      envSelection = true; explicitEnvFile = true; envFile = path.resolve(value); i++;
    } else if (args[i] === "--no-env-file") {
      if (envSelection) invalidOption();
      envSelection = true; envFile = undefined;
    } else invalidOption();
  }
  if (explicitEnvFile) {
    try {
      if (!fs.statSync(envFile).isFile()) throw new Error("Not an environment file");
      fs.accessSync(envFile, fs.constants.R_OK);
    } catch {
      throw Object.assign(new Error("Explicit environment file must be readable"), { code: "INVALID_CONFIG", param: "envFile" });
    }
  }
  if (Number(process.versions.node.split(".")[0]) < 22) throw Object.assign(new Error("Node.js 22 or newer is required"), { code: "INVALID_CONFIG" });
  let config;
  try { config = loadConfig({ env, envFile }); }
  catch (error) {
    if (error.code === "INVALID_CONFIG") throw error;
    throw Object.assign(new Error("Environment configuration could not be loaded"), { code: "INVALID_CONFIG", param: "envFile" });
  }
  validateListenerTls(config);
  if (check) { process.stdout.write(JSON.stringify(safeConfigSummary(config)) + "\n"); return; }
  const logPath = config.logMode === "console" ? undefined : config.logPath;
  await validateLogPath(logPath);
  const logger = createLogger({ logPath, maxLogBytes: config.maxLogBytes, retentionDays: config.logRetentionDays, secrets: [config.azureApiKey, config.proxyToken] });
  const server = createBridgeServer(config, { logger });
  let stopping;
  const shutdown = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      logger("shutdown", { outcome: "shutting_down" });
      try { await server.shutdown(); } finally {
        await Promise.race([logger.close(), new Promise(resolve => { const timer = setTimeout(resolve, config.timeouts.shutdownMs); timer.unref(); })]);
        process.off("SIGINT", shutdown); process.off("SIGTERM", shutdown);
      }
    })();
    return stopping;
  };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  server.on("error", error => {
    logger("server_error", { code: error.code === "EADDRINUSE" ? "EADDRINUSE" : "LISTENER_ERROR", outcome: "startup_failed" });
    process.exitCode = 1; void shutdown();
  });
  server.listen(config.port, config.host, () => logger("listening", { host: config.host, port: config.port,
    build: BUILD, configId: config.configId, outcome: "ready" }));
  return server;
}
if (require.main === module) {
  main().catch(error => {
    // Configuration errors use fixed messages/parameter names; never echo arbitrary environment values.
    const label = error.code === "INVALID_CONFIG" ? "Invalid bridge configuration" : "Bridge startup failed";
    const param = typeof error.param === "string" && /^[a-zA-Z0-9_.\[\]-]{1,160}$/.test(error.param) ? ` (${error.param})` : "";
    process.stderr.write(`${label}${param}. See configuration and migration documentation.\n`);
    process.exitCode = 1;
  });
}
module.exports = { ...adapter, createBridgeServer, safeConfigSummary, main };
