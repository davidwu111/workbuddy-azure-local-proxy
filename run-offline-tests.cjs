"use strict";
// In-process runner for confined Windows environments where Node's --test worker
// pipes are unavailable. Node 22 has no --test-isolation flag; direct node:test
// registration works on both supported versions. CI also tests the default runner.
const fs = require("node:fs");
const path = require("node:path");
const files = fs.readdirSync(__dirname).filter(name => name.endsWith(".test.js")).sort();
if (!files.length) throw new Error("No offline test files found");
for (const file of files) require(path.join(__dirname, file));
