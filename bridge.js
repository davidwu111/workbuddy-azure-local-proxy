"use strict";

// The executable boundary is the only place that loads .env or opens a log/listener.
const path = require("node:path");
const { loadConfig } = require("./config");
const { createLogger } = require("./logger");
const adapter = require("./adapter");
const { createBridgeServer, SERVICE, PROTOCOL, BUILD } = require("./server");

function safeConfigSummary(config) {
  return { service: SERVICE, protocol: PROTOCOL, build: BUILD, configId: config.configId,
    host: config.host, port: config.port, status: "configured" };
}
async function main(args = process.argv.slice(2), env = process.env) {
  let envFile = path.join(__dirname, ".env");
  let check = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--check-config-json") check = true;
    else if (args[i] === "--env-file" && args[i + 1]) envFile = path.resolve(args[++i]);
    else if (args[i] === "--no-env-file") envFile = undefined;
    else throw Object.assign(new Error("Unsupported command-line option"), { code: "INVALID_CONFIG" });
  }
  if (Number(process.versions.node.split(".")[0]) < 22) throw Object.assign(new Error("Node.js 22 or newer is required"), { code: "INVALID_CONFIG" });
  const config = loadConfig({ env, envFile });
  if (check) { process.stdout.write(JSON.stringify(safeConfigSummary(config)) + "\n"); return; }
  const logger = createLogger({ logPath: config.logPath, maxLogBytes: config.maxLogBytes, retentionDays: config.logRetentionDays, secrets: [config.azureApiKey, config.proxyToken] });
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
