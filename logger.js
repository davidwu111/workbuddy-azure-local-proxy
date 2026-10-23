"use strict";
const fs = require("node:fs/promises");
const { constants } = require("node:fs");

// No destination is touched on import or in console-only mode. Opening with
// append preserves existing bytes; nonblocking/no-follow also prevents a FIFO
// or symbolic-link target from becoming a startup hang or unintended write.
async function validateLogPath(logPath) {
  if (!logPath) return;
  let handle;
  try {
    // Rotation must create/remove sibling entries even when the current file
    // itself is appendable. Check obvious directory permission failures early.
    await fs.access(require("node:path").dirname(logPath), constants.W_OK);
    try { if (!(await fs.lstat(logPath)).isFile()) throw new Error("Not a regular file"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    handle = await fs.open(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT |
      (constants.O_NONBLOCK || 0) | (constants.O_NOFOLLOW || 0), 0o600);
    if (!(await handle.stat()).isFile()) throw new Error("Not a regular file");
  } catch {
    throw Object.assign(new Error("Log destination must be a writable regular file"), { code: "INVALID_CONFIG", param: "logPath" });
  } finally { if (handle) await handle.close(); }
}
const { CHAT_REQUEST_FIELDS, WORKBUDDY_MESSAGE_FIELDS, SAFE_METADATA_KEY, sanitizeMetadataKey } = require("./chat-contract");
const { STAGES, CODES, safeValidationParam } = require("./diagnostics");
const NORMALIZED_FIELDS = new Set([...CHAT_REQUEST_FIELDS, "stream_options.include_usage", "stream_options.include_obfuscation", ...WORKBUDDY_MESSAGE_FIELDS.map(name => `messages.${name}`)]);
const safeNormalizedField = value => {
  if (typeof value !== "string" || value.length > 160) return false;
  if (NORMALIZED_FIELDS.has(value)) return true;
  if (!value.startsWith("messages.")) return false;
  const key = value.slice("messages.".length);
  const masked = sanitizeMetadataKey(key);
  return Boolean(masked && SAFE_METADATA_KEY.test(masked) && masked === key);
};

const STRING_FIELDS = new Set(["requestId", "upstreamRequestId", "deployment", "variant", "version", "model", "effort", "mode", "context", "outcome", "finishReason", "code", "method", "path", "host", "build", "configId", "eventName"]);
const NUMBER_FIELDS = new Set(["status", "latencyMs", "firstTokenMs", "port", "active", "dropped", "input_tokens", "output_tokens", "total_tokens", "reasoning_tokens", "cached_tokens", "cache_write_tokens", "bytesOut", "queuedFor"]);
const SAFE_PATHS = new Set(["/healthz", "/readyz", "/v1/models", "/v1/chat/completions", "/v1/responses"]);
const USAGE_FIELDS = new Set(["input_tokens", "output_tokens", "total_tokens", "prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_tokens", "cache_write_tokens", "input_tokens_details", "output_tokens_details", "prompt_tokens_details", "completion_tokens_details"]);
function safeUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 2) return undefined;
  const out = {};
  for (const [key, part] of Object.entries(value)) {
    if (!USAGE_FIELDS.has(key)) continue;
    if (Number.isSafeInteger(part) && part >= 0) out[key] = part;
    else if (part && typeof part === "object") { const nested = safeUsage(part, depth + 1); if (nested && Object.keys(nested).length) out[key] = nested; }
  }
  return out;
}
function localTimestamp(date = new Date()) {
  if (!Number.isFinite(date.getTime())) throw new RangeError("Invalid log timestamp");
  const pad = (value, digits = 2) => String(value).padStart(digits, "0");
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}
function safeRecord(event, fields = {}, now = new Date()) {
  const out = { time: localTimestamp(now), event: /^[a-z_]{1,64}$/.test(event) ? event : "operational_event" };
  for (const [key, value] of Object.entries(fields)) {
    if (STRING_FIELDS.has(key) && typeof value === "string" && /^[a-zA-Z0-9._:/-]{1,128}$/.test(value)) {
      out[key] = key === "path" && !SAFE_PATHS.has(value) ? "unmatched" : value;
    } else if (NUMBER_FIELDS.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0) out[key] = value;
    else if (key === "usage") out.usage = safeUsage(value);
    else if (key === "normalizedFields" && Array.isArray(value)) out.normalizedFields = [...new Set(value.slice(0, 64).filter(safeNormalizedField))];
    else if (key === "validationKey" && typeof value === "string" && SAFE_METADATA_KEY.test(value)) out.validationKey = value;
    else if (key === "stage" && STAGES.has(value)) out.stage = value;
    else if (key === "validationType" && value === "invalid_request_error") out.validationType = value;
    else if (key === "validationCode" && CODES.has(value)) out.validationCode = value;
    else if (key === "validationParam") out.validationParam = safeValidationParam(value);
    else if (key === "validationValueType" && ["null", "array", "string", "number", "boolean", "object", "undefined", "unavailable"].includes(value)) out.validationValueType = value;
  }
  return out;
}
function dayStamp(date) {
  const pad = (value, digits = 2) => String(value).padStart(digits, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
// Archive files live beside the active log and share its base name, e.g.
// bridge-2026-10-21.log, bridge-2026-10-21.2.log, and the legacy bridge.log.old.
function archiveBase(logPath) { return logPath.replace(/\.log$/i, ""); }
function isArchiveName(name, base, activeName) {
  if (name === `${activeName}.old`) return true;
  const prefix = `${base}-`;
  return name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name.slice(prefix.length));
}
function createLogger({ logPath, maxLogBytes = 10 * 1024 ** 2, maxQueueBytes = 64 * 1024, stdout = process.stdout, secrets = [], retentionDays = 7, now = () => new Date() } = {}) {
  let queue = Promise.resolve(); let queuedBytes = 0; let dropped = 0; let closed = false; let consoleBlocked = false; let consoleFailed = false;
  let lastDay = null, lastPrune = 0;
  const consoleDrain = () => { consoleBlocked = false; };
  const consoleError = () => { consoleFailed = true; };
  if (stdout && typeof stdout.on === "function") stdout.on("error", consoleError);

  const prune = async (today) => {
    const dir = require("node:path").dirname(logPath);
    const base = require("node:path").basename(archiveBase(logPath));
    const activeName = require("node:path").basename(logPath);
    const cutoff = today.getTime() - retentionDays * 86_400_000;
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isFile() || !isArchiveName(entry.name, base, activeName)) continue;
      const target = require("node:path").join(dir, entry.name);
      try {
        const info = await fs.stat(target);
        if (info.mtimeMs < cutoff) await fs.rm(target, { force: true });
      } catch { /* A concurrent delete or permission error must not stop logging. */ }
    }
  };

  const log = (event, fields) => {
    if (closed) return false;
    const record = safeRecord(event, fields);
    for (const [key, value] of Object.entries(record)) {
      if (typeof value === "string" && key !== "time" && key !== "event" && secrets.some(secret => typeof secret === "string" && secret && value.includes(secret))) delete record[key];
    }
    if (dropped) record.dropped = dropped;
    const line = JSON.stringify(record) + "\n";
    const bytes = Buffer.byteLength(line);
    if (queuedBytes + bytes > maxQueueBytes || (logPath && bytes > maxLogBytes)) { dropped++; return false; }
    dropped = 0;
    if (stdout && !consoleBlocked && !consoleFailed) {
      try {
        if (stdout.write(line) === false && !consoleFailed) { consoleBlocked = true; stdout.once("drain", consoleDrain); }
      } catch { consoleFailed = true; }
    }
    if (!logPath) return true;
    queuedBytes += bytes;
    queue = queue.then(async () => {
      const current = now();
      const day = dayStamp(current);
      let info;
      try {
        info = await fs.lstat(logPath);
        if (!info.isFile()) throw new Error("Not a regular log destination");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      const size = info?.size || 0;
      // A restarted process has no in-memory day state: recover it from the
      // existing active file's last write, without reading any log contents.
      const previousDay = lastDay ?? (size ? dayStamp(info.mtime) : day);
      const dayChanged = previousDay !== day;
      const oversized = size > 0 && size + bytes > maxLogBytes;
      if (size > 0 && (dayChanged || oversized)) {
        const stamp = dayChanged ? previousDay : day;
        let sequence = dayChanged ? 0 : 1;
        for (;;) {
          const suffix = sequence ? `.${sequence}` : "";
          const archive = `${archiveBase(logPath)}-${stamp}${suffix}.log`;
          try {
            // link is exclusive, unlike rename on POSIX. Existing archives
            // survive restarts and collisions, including dangling symlinks.
            await fs.link(logPath, archive);
            await fs.unlink(logPath);
            break;
          } catch (error) {
            if (error.code === "EEXIST") { sequence++; continue; }
            if (error.code === "ENOENT") break;
            throw error;
          }
        }
      }
      lastDay = day;
      await fs.appendFile(logPath, line, { encoding: "utf8", mode: 0o600 });
      // Retention work is bounded: at most once an hour per logger instance.
      if (current.getTime() - lastPrune > 3_600_000) { lastPrune = current.getTime(); await prune(current); }
    }).catch(() => { dropped++; }).finally(() => { queuedBytes -= bytes; });
    return true;
  };
  log.flush = () => queue;
  log.close = async () => { closed = true; if (stdout && typeof stdout.off === "function") { stdout.off("drain", consoleDrain); stdout.off("error", consoleError); } await queue; };
  log.stats = () => ({ queuedBytes, dropped });
  return log;
}
module.exports = { createLogger, validateLogPath, safeRecord, safeUsage, localTimestamp };
