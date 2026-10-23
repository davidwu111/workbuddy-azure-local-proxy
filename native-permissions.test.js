"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const { FEATURES, normalizeProfile, normalizeNativePolicies } = require("./native-permissions");

test("native profiles default deny, deep-freeze lists, and use null-prototype maps", () => {
  const map = normalizeNativePolicies({}, ["alias"]);
  assert.equal(Object.getPrototypeOf(map), null); assert.deepEqual(map.alias.features, []); assert.equal(map.alias.allowStore, false);
  assert.ok(Object.isFrozen(map) && Object.isFrozen(map.alias) && Object.isFrozen(map.alias.features));
  const profile = normalizeProfile({ features: [...FEATURES], mcpServers: [{ label: "tools", url: "https://mcp.example/api", toolNames: ["lookup"] }], vectorStoreIds: ["vs_1"], imageModels: ["gpt-image-1"] });
  assert.equal(Object.getPrototypeOf(profile), null); assert.equal(Object.getPrototypeOf(profile.mcpServers[0]), null);
  assert.ok(Object.isFrozen(profile.mcpServers[0].toolNames));
});
test("profiles reject unknown keys/types, duplicates, alias smuggling, prototype tricks, getters and unsafe URLs", () => {
  for (const value of [{ features: ["web-search", "web-search"] }, { features: "web-search" }, { feature: true }, { allowStore: 1 }, { mediaUrls: ["http://example.com"] }, { mediaUrls: ["https://u:p@example.com/a"] }, { mediaUrls: ["https://127.0.0.1/x"] }, { mediaUrls: ["https://example.com/?token=x"] }, { mediaUrls: ["https://example.com/#x"] }, { mcpServers: [{ label: "x", url: "https://example.com", headers: { authorization: "secret" } }] }]) assert.throws(() => normalizeProfile(value), { code: "INVALID_CONFIG" });
  assert.throws(() => normalizeNativePolicies({ other: {} }, ["alias"]), { code: "INVALID_CONFIG" });
  const getter = {}; Object.defineProperty(getter, "features", { enumerable: true, get() { throw Error("executed"); } });
  assert.throws(() => normalizeProfile(getter), { code: "INVALID_CONFIG" });
  const polluted = Object.create({ features: ["web-search"] }); assert.throws(() => normalizeProfile(polluted), { code: "INVALID_CONFIG" });
  assert.throws(() => normalizeProfile(JSON.parse('{"__proto__":{"polluted":true}}')), { code: "INVALID_CONFIG" });
});
