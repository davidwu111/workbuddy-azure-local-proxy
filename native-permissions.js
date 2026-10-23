"use strict";

// Plain function tools stay in the initial contract; every identifier below requires an explicit grant.
const FEATURES = Object.freeze(["code-interpreter", "file-search", "web-search", "image-generation", "mcp", "custom-tool", "image-input", "file-input"]);
const KEYS = Object.freeze(["features", "allowStore", "vectorStoreIds", "fileIds", "containerIds", "customToolNames", "mediaUrls", "imageModels", "mcpServers", "verifiedCapabilities"]);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
function invalid(path) { throw Object.assign(new Error(`Invalid native policy: ${path}`), { code: "INVALID_CONFIG", param: path }); }
function clone(value, path) {
  if (!object(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid(path);
  const out = Object.create(null);
  for (const key of Object.keys(value)) {
    const desc = Object.getOwnPropertyDescriptor(value, key);
    if (!desc || !own(desc, "value")) invalid(path);
    Object.defineProperty(out, key, { value: desc.value, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
function bounded(value, path, pattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) {
  if (typeof value !== "string" || !pattern.test(value)) invalid(path);
  return value;
}
function uniqueList(value, path, validator, max = 64) {
  if (!Array.isArray(value) || value.length > max) invalid(path);
  const seen = new Set(); const out = value.map((item, i) => { const v = validator(item, `${path}[${i}]`); if (seen.has(v)) invalid(`${path}[${i}]`); seen.add(v); return v; });
  return Object.freeze(out);
}
function approvedUrl(value, path) {
  if (typeof value !== "string" || value.length > 2048 || /[\u0000-\u0020\\]/.test(value)) invalid(path);
  let url; try { url = new URL(value); } catch { invalid(path); }
  const host = url.hostname.toLowerCase();
  const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith("[") || host.includes(":");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.port && url.port !== "443"
    || !host || isIpLiteral || !host.includes(".") || host.endsWith(".") || host === "localhost" || host.endsWith(".localhost")
    || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".home.arpa")) invalid(path);
  return url.href;
}
function normalizeProfile(source, path = "nativePolicies.profile") {
  const raw = clone(source, path);
  for (const key of Object.keys(raw)) if (!KEYS.includes(key)) invalid(`${path}.${key}`);
  const p = Object.create(null);
  p.features = uniqueList(raw.features ?? [], `${path}.features`, (v, at) => { if (!FEATURES.includes(v)) invalid(at); return v; }, FEATURES.length);
  p.allowStore = raw.allowStore === undefined ? false : raw.allowStore;
  if (typeof p.allowStore !== "boolean") invalid(`${path}.allowStore`);
  for (const name of ["vectorStoreIds", "fileIds", "containerIds"]) p[name] = uniqueList(raw[name] ?? [], `${path}.${name}`, bounded, 128);
  p.customToolNames = uniqueList(raw.customToolNames ?? [], `${path}.customToolNames`, (v, at) => bounded(v, at, /^[A-Za-z0-9_-]{1,64}$/), 64);
  p.mediaUrls = uniqueList(raw.mediaUrls ?? [], `${path}.mediaUrls`, approvedUrl, 64);
  p.imageModels = uniqueList(raw.imageModels ?? [], `${path}.imageModels`, bounded, 32);
  p.verifiedCapabilities = uniqueList(raw.verifiedCapabilities ?? [], `${path}.verifiedCapabilities`, (v, at) => { if (v !== "image-generation-streaming") invalid(at); return v; }, 8);
  const servers = raw.mcpServers ?? [];
  if (!Array.isArray(servers) || servers.length > 16) invalid(`${path}.mcpServers`);
  const serverLabels = new Set(), serverUrls = new Set();
  p.mcpServers = Object.freeze(servers.map((sourceServer, i) => {
    const at = `${path}.mcpServers[${i}]`, s = clone(sourceServer, at);
    for (const k of Object.keys(s)) if (!["label", "url", "toolNames"].includes(k)) invalid(`${at}.${k}`);
    const label = bounded(s.label, `${at}.label`, /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/), url = approvedUrl(s.url, `${at}.url`);
    if (serverLabels.has(label) || serverUrls.has(url)) invalid(at); serverLabels.add(label); serverUrls.add(url);
    const toolNames = uniqueList(s.toolNames ?? [], `${at}.toolNames`, (v, q) => bounded(v, q, /^[A-Za-z0-9_-]{1,64}$/), 64);
    if (!toolNames.length) invalid(`${at}.toolNames`);
    return Object.freeze(Object.assign(Object.create(null), { label, url, toolNames }));
  }));
  if (p.features.includes("file-search") && !p.vectorStoreIds.length) invalid(`${path}.vectorStoreIds`);
  if (p.features.includes("image-generation") && !p.imageModels.length) invalid(`${path}.imageModels`);
  if (p.features.includes("mcp") && !p.mcpServers.length) invalid(`${path}.mcpServers`);
  return Object.freeze(p);
}
function normalizeNativePolicies(value, aliases) {
  const raw = clone(value ?? Object.create(null), "nativePolicies");
  const result = Object.create(null), allowed = new Set(aliases);
  for (const alias of Object.keys(raw)) {
    if (!allowed.has(alias)) invalid(`nativePolicies.${alias}`);
    result[alias] = normalizeProfile(raw[alias], `nativePolicies.${alias}`);
  }
  for (const alias of aliases) if (!own(result, alias)) result[alias] = normalizeProfile(Object.create(null), `nativePolicies.${alias}`);
  return Object.freeze(result);
}
module.exports = { FEATURES, normalizeProfile, normalizeNativePolicies, approvedUrl };
