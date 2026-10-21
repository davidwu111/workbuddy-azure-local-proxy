# Offline validation record — 21 October 2026

This record describes **local synthetic validation**, not Azure or WorkBuddy acceptance. Official public documentation was fetched without authentication; no inference/API deployment calls, real credentials, WorkBuddy invocation, real tool execution or scheduled-task installation were used. The [real acceptance plan](<acceptance.md>) remains separately approval-gated and **NOT RUN**.

## Linux branch integration (`adapter-v2.10-linux`)

Integrated main tip `3a27007` into Linux tip `b52c775` (merge base `955b811`) on
21 October 2026. The merge preserves Linux LAN binding, native HTTPS and the
user systemd example while adopting the shared adapter/config/transport rewrite.
This is an **uncommitted local merge**, not a pushed deployment or hosted-CI result.

### Observed final checks on Windows

| Runtime / check | Result |
|---|---|
| Node **v22.22.2**, complete in-process offline suite | **150 total, 146 passed, 0 failed, 4 skipped**; approximately 7.27 s |
| Node **v24.20.0**, complete in-process offline suite | **150 total, 146 passed, 0 failed, 4 skipped**; approximately 7.13 s |
| JavaScript/CommonJS syntax checks, both runtimes | passed for all root source/test files |
| Windows launcher PowerShell AST | passed |
| Working-tree and staged whitespace checks | passed; informational LF/CRLF warnings only |

The four skipped tests are Linux-specific: binding only `127.0.0.2`, real
foreground SIGINT and SIGTERM with an active upload/repeated signal, and rejecting
an appendable active log in a read-only archive directory (also skipped for root).
Linux-only FIFO/device and POSIX permission assertions inside other tests were
not executed on Windows. **No Linux runtime/systemd execution is claimed.** WSL
was not usable on this host (`Wsl/CallMsi/Install/REGDB_E_CLASSNOTREG`); no Linux
runtime, persistent service or distribution was installed as a workaround.

Observed HTTPS checks use the explicitly trusted public synthetic loopback
[certificate fixtures](<../test-fixtures/tls/README.md>), not disabled certificate
verification. Coverage includes health/readiness/model aliases, auth, nonstream
and SSE conversion, one terminal DONE, untrusted certificate rejection, invalid
and valid-but-mismatched key pairs, oversized/non-regular PEM rejection, and
bounded shutdown of a socket that has not completed its TLS handshake.

CLI subprocesses use isolated process environments, `--no-env-file` or temporary
explicit fixtures, and temporary log/output destinations. No production dotenv,
operational log, Azure credential or deployment certificate was read or changed.
Logger regressions cover restart archive collisions, initial previous-day
rotation, private new files, missing parents, and console-only behavior. The
Windows launcher retains identity/path tests and now refuses plaintext probes
for a configured HTTPS listener.

Reproduction on the installed Windows runtimes:

```powershell
& 'C:\Users\yefan\.workbuddy\binaries\node\versions\22.22.2-6\node.exe' .\run-offline-tests.cjs
& 'C:\Program Files\nodejs\node.exe' .\run-offline-tests.cjs
```

The existing Node 22/24 Ubuntu/Windows [CI matrix](<../.github/workflows/test.yml>)
includes the new tests automatically. Hosted CI and actual Linux signal/binding/
permission checks remain pending until this merge is committed and tested there.
Real Azure/WorkBuddy acceptance remains separately authorized and **NOT RUN**.
The [Linux upgrade/service guide](<../LINUX.md>) describes configuration migration,
TLS trust, journal/file logging and restart instructions; those instructions were
reviewed but not executed against a live service.

## Windows launcher path assertion follow-up (`adapter-v2.9`)

The subsequent Windows CI failure reported a strict equality assertion in the
relative-path launcher test. Locally, the original test passes with the normal
TEMP spelling but fails with `process.env.TEMP = process.env.TEMP.toLowerCase()`:
PowerShell returns an absolute `C:\...` path while Node's fixture uses `c:\...`.
Both refer to the same file. The launcher already resolves the executable and
explicit environment path before `Push-Location`; no launcher behavior change
was needed for this reproduced failure. The exact hosted actual/expected strings
were not retrieved, so this is a demonstrated failure mechanism, not independent
confirmation of the hosted runner's path spelling.

The regression now exercises original and lowercase-drive fixture paths, requires
exactly one `--env-file` argument with an absolute value, and compares both paths
through `fs.realpath` instead of comparing raw spellings. A relative, missing or
wrong-file argument still fails, including after the launcher's cwd shift.

| Check | Result |
|---|---|
| Original launcher suite with lowercase TEMP, before fix | **4 passed, 1 failed**; drive-letter case mismatch |
| Fixed launcher suite, normal and lowercase TEMP | **5/5 passed** each |
| Node **v24.20.0**, `node run-offline-tests.cjs` | **131/131 passed**, no skips |
| Node **v22.22.2**, `node run-offline-tests.cjs` | **131/131 passed**, no skips |
| All JavaScript syntax checks, Node 22/24 | passed |
| Launcher AST parse and `git diff --check` | passed |

Validation used Windows PowerShell 5.1 launcher subprocesses and the in-process
offline runner because confined environments do not support test-worker pipes.
Hosted Windows/Linux CI confirmation remains pending.

## CI launcher hang fix (`adapter-v2.9`)

The first GitHub Actions run passed syntax checks but failed all four Windows
launcher tests with *"Isolated launcher test timed out"*. Root cause: the
launcher's two `Invoke-RestMethod` loopback probes lacked `-UseBasicParsing`, so
Windows PowerShell 5.1 engaged the IE DOM parser and stalled on a clean image
during IE first-run configuration. System/web proxy auto-detection could stall
the same way.

Fixes:

- both probes now pass `-UseBasicParsing` and the launcher clears
  `[System.Net.WebRequest]::DefaultWebProxy` for its loopback-only checks
- the test helper redirects child output to a file (pipes are unavailable in some
  sandboxes) and, on timeout, kills the whole process tree and reports the
  captured output instead of a bare "timed out"
- per-test timeout raised to 120 s and the child guard to 60 s, so a slow CI
  image fails loudly rather than silently
- a static regression test asserts both probes keep `-UseBasicParsing`, a
  2-second timeout and proxy bypass

| Check | Result |
|---|---|
| Node **v24.20.0** full suite (incl. 4 Windows launcher tests) | **131/131 passed** |
| Node **v22.22.2** full suite | **131/131 passed** |
| Launcher AST parse | passed |

Hosted-CI confirmation is still required; this was verified on the local Windows
host only.

## Log rotation and retention (`adapter-v2.9`)

Logging now rotates **daily** rather than only by size, and pruning is automatic:

- active file: `BRIDGE_LOG_PATH` (default `bridge.log`)
- day change → `<base>-YYYY-MM-DD.log` (for example `bridge-2026-10-21.log`)
- size overflow within a day → `<base>-YYYY-MM-DD.N.log`
- archives older than `BRIDGE_LOG_RETENTION_DAYS` (default **7**) are deleted,
  including a legacy `bridge.log.old`
- pruning runs at most once an hour and only considers files matching this log's
  own archive pattern; unrelated files in the directory are never touched

Verified offline with injected clocks and filesystem timestamps:

| Case | Result |
|---|---|
| Day change archives under the ending day and starts a fresh active file | passed |
| Stale archive (9 days) and legacy `.old` deleted; 2-day archive kept; unrelated `notes-2020-01-01.log` kept | passed |
| Size rotation produces dated, sequenced archives | passed |
| `BRIDGE_LOG_RETENTION_DAYS` default 7, accepts 30, rejects 0/-1/1.5/"7"/3651 | passed |

No production log was deleted or rewritten during this work; the running bridge
keeps its existing file until it is restarted.

## Concurrency admission (`adapter-v2.8`)

The seventh report showed the agents replying but their task records failing,
with one retry rejected by a 429. The log confirmed **bridge-originated** 429s:

```text
15:00:48  status 429  stage authentication  latencyMs 1
15:00:49  status 429  stage authentication  latencyMs 0
```

Those were the `maxConcurrent: 4` admission cap rejecting requests while three
sub-agents plus the main agent ran in parallel. A non-SSE 429 is plausibly what
the client reported as an "empty response stream". `bytesOut` was **never zero**
across the 24 instrumented streaming responses (minimum 1,350 bytes), so the
bridge did not emit empty bodies.

Changes:

- `maxConcurrent` default raised 4 → **16**, since multi-agent workflows
  legitimately run several requests at once.
- Requests above the cap now **wait for a slot** (bounded by `maxQueue`, default
  32, and `capacityWaitMs`, default 30 s) instead of failing immediately. Set
  `maxQueue: 0` to restore immediate rejection.
- Capacity failures report `stage: "capacity"` (previously mislabelled
  `authentication`), `type: "rate_limit_error"` and `Retry-After: 1`.
- Queue time is logged as `queuedFor` (ms).
- Credential redaction now ignores values shorter than 8 characters: with a
  one-character test credential every matching letter was rewritten and
  `type`/`code` were dropped from error bodies.

| Follow-up check | Actual result |
|---|---|
| Node **v24.20.0** full `node run-offline-tests.cjs` | **131/131 passed** |
| Node **v22.22.2** full `run-offline-tests.cjs` | **131/131 passed** |
| Syntax, changed modules, both runtimes | Passed |

**Unresolved:** agent 2's failure had no specific error, and no bridge log entry
corresponds to it. Whether the client's "empty stream" was the 429, or a separate
orchestration defect, requires a live retry with these changes.

## Annotation echo round-trip (`adapter-v2.7`)

The live log for the sixth report showed 19 consecutive HTTP 200 responses —
sub-agents ran, tool calls streamed, cache reuse reached 36,684 tokens — then one
rejection whose `validationKey` finally appeared:

```text
validationParam: messages[19].<unknown_field>
validationKey:   content[0].annotations
validationValueType: array
```

That is the bridge's **own output** coming back. `extractResponse` maps Azure
citations into a Chat `annotations` extension; WorkBuddy stores it and replays it
inside the assistant content block on the next turn, where the content-block
validator rejected the key. The failure was self-inflicted round-trip
incompatibility, not a new client feature.

Fix: assistant `content[].annotations` (text and refusal blocks) and
message-level `annotations` are accepted as bounded opaque JSON and ignored —
never forwarded, never reinterpreted as request semantics. Non-JSON or oversized
values still fail.

Also added `bytesOut` to request logs: the byte count actually written
downstream. The reported "empty stream, 0 data chunks, 0 bytes" had no matching
bridge error entry, so this field will distinguish a genuine zero-byte response
from a client-side report.

| Follow-up check | Actual result |
|---|---|
| Node **v24.20.0** full `node run-offline-tests.cjs` | **124/124 passed** |
| Node **v22.22.2** full `run-offline-tests.cjs` | **124/124 passed** |
| Syntax, changed modules, both runtimes | Passed |

**Unresolved:** the sub-agent "empty stream" symptom is not explained by any
logged bridge failure. Real-client confirmation is still required.

## Sub-agent verification — arbitrary client keys (`adapter-v2.6`)

The live log for the fifth report showed the sub-agent flow **working**: 28
consecutive HTTP 200 responses with `messages.isSubAgent`,
`messages.argumentsDisplayText`, `messages.usage`, `messages.rawUsage`,
`messages.reasoning` and other client keys absorbed, tool calls streaming, and
turns ending with `finishReason: stop`. Cache reuse rose from 0 to 36,633 tokens
across the turn.

Exactly one request then failed: `messages[40]`, `unknown_parameter`,
`validationValueType: array`, again with no `validationKey`. That absence proved
the key contained a character outside the then-allowed `[A-Za-z0-9_.:-]` — the
same class of bug as v2.5, one character class wider.

Fix: in `auto` mode, any message-level key up to 128 characters is absorbed
regardless of characters used, and `validationKey` reports the key with only
control/non-ASCII characters masked. Reserved/standard message fields, unknown
top-level fields, malformed metadata and the size caps are unchanged.

| Follow-up check | Actual result |
|---|---|
| Node **v24.20.0** full `node run-offline-tests.cjs` | **122/122 passed** |
| Node **v22.22.2** full `run-offline-tests.cjs` | **122/122 passed** |
| Syntax, changed modules, both runtimes | Passed |

**Important limitation:** the 28 successes and the single failure come from the
real client, but the behaviour after this fix is verified only offline. Two
successive live reports failed at a *later* request than the previous fix covered,
so a further live retry is the only proof that this class is now closed.

## Tool-call follow-up — bounded metadata absorption (`adapter-v2.4`)

The live log for the fourth report showed a success and the failures side by side:

- `14:36:40.040` — HTTP 200, `finishReason: tool_calls`, `effort: high`,
  `normalizedFields: ["messages.startsNewUserRequest","messages.agent","messages.conversationRequestId"]`,
  `cache_write_tokens: 34235`.
- `14:36:40.421`–`14:36:46.444` — five `unknown_parameter` rejections on
  `messages[1]`/`messages[2]`, every one `validationValueType: string`.

The success proves the three listed extensions and the tool-call round trip work.
The failures were *new, still-unnamed* annotations on the tool-call follow-up — one
per turn, because the diagnostic deliberately collapsed keys to `<unknown_field>`
while the allowlist knew only three names.

Two changes:

1. **`validationKey`** — a `unknown_parameter` rejection now also records the
   unknown key itself (bounded 1–64 character identifier), so a strict-mode
   failure is self-diagnosing without exposing values. Non-identifier keys still
   collapse to `<unknown_field>`.
2. **`BRIDGE_CLIENT_METADATA_MODE`** — `auto` (default) absorbs any non-standard
   **message-level** key as bounded opaque JSON and records its name in
   `normalizedFields`; `strict` keeps reject-and-name behaviour. `auto` never
   applies to standard message fields (`name`, `audio`, `function_call`, …),
   bridge-reserved fields (`reasoning_content`, `phase`), unknown **top-level**
   fields, or malformed metadata.

New regressions: auto absorption of `turnToken`/`isError`/`toolName` across a
realistic three-message tool history while standard `name`/`audio` still fail;
top-level unknowns still rejected; malformed metadata still fails; `strict` reports
`validationKey` exactly; `ignoredClientFields` returns names only; and marker
assertions that metadata values reach neither Azure nor logs.

| Follow-up check | Actual result |
|---|---|
| Node **v24.20.0** focused suite (adapter/config/logger/server) | **101/101 passed** |
| Node **v24.20.0** full `node run-offline-tests.cjs` | **122/122 passed** |
| Node **v22.22.2** full `run-offline-tests.cjs` | **122/122 passed** |
| Syntax, changed modules, both runtimes | Passed |

## Client-metadata registry follow-up — `conversationRequestId`

Current build: **`adapter-v2.3`**. The live log for the third reported failure
confirmed the diagnostics working as designed:

```text
stage=request_conversion validationCode=unknown_parameter
validationParam=messages[1].<unknown_field> validationValueType=string
```

The operator supplied the field name (`conversationRequestId`) and client version
(WorkBuddy 5.8.3). Rather than adding a fourth hardcoded name, the ignored
client-metadata set is now **explicit and configurable**:

- defaults to `startsNewUserRequest`, `agent`, `conversationRequestId`;
- `BRIDGE_CLIENT_METADATA_FIELDS` (JSON array, ≥16 names) extends it with no code
  change;
- names are bounded identifiers and may not claim a standard or bridge-reserved
  message field, so configuration cannot reopen request semantics;
- values stay bounded opaque JSON, are never forwarded, and never become provider
  metadata or conversation identity;
- the effective list participates in the public `configId`.

New regressions: `conversationRequestId` in several shapes accepted and stripped
in both response modes; a configured extra name accepted, an unlisted name still
rejected; reserved/standard names rejected at startup; startup JSON/enumeration
validation; and marker-based assertions that neither the value nor the field name
reaches Azure payloads or logs.

| Follow-up check | Actual result |
|---|---|
| Node **v24.20.0**, `node run-offline-tests.cjs` | **116/116 passed** |
| Node **v22.22.2**, explicit managed executable + runner | **116/116 passed** |
| Changed-module syntax, both runtimes | Passed |

The 116/116 snapshot below is retained as historical evidence.

## Standards-first classification and WorkBuddy 5.8.3 follow-up

Current build: **`adapter-v2.2`**. Two reported local 400s (`messages[].startsNewUserRequest`, `messages[].agent`) were reproduced with synthetic data before this change. Both are nonstandard WorkBuddy message properties; neither is forwarded, and neither acquires authority, provider metadata or identity. The deeper fix is in [chat-contract.js](<../chat-contract.js>) plus the classification in [adapter.js](<../adapter.js>): standard Chat fields are recognised, then mapped, deliberately normalized, or rejected as `unsupported_parameter`; unknown fields get `unknown_parameter`; malformed values stay `invalid_parameter`.

Standard behaviour corrected here: nullable unset options, omitted assistant content with tool calls/refusal, nullable `strict`, no-tool `tool_choice:"auto"`/`parallel_tool_calls`, and inert disabled forms (`logprobs:false`, zero penalties, empty bias/stop, text-only modalities, `include_obfuscation:false`). Enabled semantics remain rejected rather than dropped: `n>1`, stop sequences, logprobs/top_logprobs, penalties, bias, seed, audio, moderation, service tier, retention, web search, custom tools/choices and non-root schemas. `store:null` resolves to the declared `store:false`; `prompt_cache_key:null` clears a configured key.

[diagnostics.js](<../diagnostics.js>) adds privacy-safe failure telemetry: fixed stage, type, code, sanitised parameter path and JSON type only. Tests assert that prompts, participant names, metadata values, arbitrary field names, credential markers and getter accessors never reach logs.

| Follow-up check | Actual result |
|---|---|
| Node **v24.20.0**, `node run-offline-tests.cjs` | **116/116 passed**, zero failures/cancelled/skipped |
| Node **v22.22.2**, explicit managed executable + runner | **116/116 passed**, zero failures/cancelled/skipped |
| Syntax of changed modules on both runtimes | Passed |

Suite composition: adapter 44, configuration 6, import/diagnostic 2, launcher 4, logger 11, server 32, SSE/body 14. Twelve new cases (adapter +7, logger +3, server +2) cover the two reported fields, nullable defaults, nonnullable options, unsupported-versus-unknown classification, `top_logprobs:0` logprob coupling, agent bounds/accessors/cycles, assistant omission, nullable strictness, no-tool controls, and safe telemetry in both response modes.

The earlier 101/101 snapshot below is retained as historical evidence.

## WorkBuddy metadata and local-time follow-up

Current build: **`adapter-v2.1`**. The reported `messages[1].startsNewUserRequest` rejection was reproduced with synthetic boolean values before this follow-up. The fix accepts only boolean message-level hints and deliberately ignores them in stateless Responses conversion. It does not truncate/reorder history, change tools/budgets/cache/storage, or infer conversation/branch identity; other unknown fields remain rejected.

New log records use the Node process's local timezone and an explicit ISO UTC offset. The pure formatter produced `2026-10-21T11:45:08.951+08:00` on this Windows host for the synthetic instant `2026-10-21T03:45:08.951Z`. Earlier production log records are not rewritten. The build tag was incremented so the launcher refuses to reuse an older running process rather than claiming the fix is already active. No running bridge was restarted.

| Final follow-up check | Actual result |
|---|---|
| Node **v24.20.0**, `node run-offline-tests.cjs` | **101/101 passed**, zero failures/cancelled/skipped; about 4.695 s |
| Node **v22.22.2**, explicit managed executable + `run-offline-tests.cjs` | **101/101 passed**, zero failures/cancelled/skipped; about 4.924 s |
| Focused adapter/logger/server run before the build-tag update | **75/75 passed** |
| Syntax of all 14 JavaScript/CJS files on both runtimes | Passed |
| Unrelated-source preservation | Eight pre-patch source/license/ignore hashes matched; server build-tag and launcher identity fixtures changed deliberately |

The current suite contains [adapter tests](<../adapter.test.js>) 37, [configuration tests](<../config.test.js>) 6, [import/diagnostic tests](<../bridge.test.js>) 2, [launcher tests](<../launcher.test.js>) 4, [logger tests](<../logger.test.js>) 8, [server fixtures](<../server.test.js>) 30, and [SSE/body fixtures](<../sse.test.js>) 14. Seven new cases cover boolean hint acceptance/rejection and unchanged message/tool semantics, HTTP streaming/nonstreaming conversion, and local timestamps across UTC, positive/negative/half-/quarter-hour offsets, rollover and DST. The existing launcher case also checks rejection of the old build without replacement.

Commands actually used for the follow-up:

```powershell
node --test --test-isolation=none adapter.test.js logger.test.js server.test.js
node run-offline-tests.cjs
& 'C:\Users\yefan\.workbuddy\binaries\node\versions\22.22.2-6\node.exe' .\run-offline-tests.cjs
# Each of the 14 *.js/*.cjs files was also checked with --check on both executables.
git diff --check
```

Tests use isolated configuration, injected upstreams, owned ephemeral loopback listeners and temporary files. Timezone tests change only their own process environment and restore it; Windows timezone settings are not changed. Production credentials/configuration/logs were not changed, no paid Azure calls were made, and no WorkBuddy end-to-end rerun is claimed. A preceding diagnostic inspected the operational log with the user's authorization, without capturing private prompts/tool arguments or loading the production environment file. The earlier 94-test results below are retained as historical evidence, not the latest snapshot.

## Initial review implementation snapshot — before the WorkBuddy/local-time follow-up

After the final transport duplicate-call guard and logger console-failure protection, the Team Lead reported these complete Windows runs:

| Runtime / command | Tests | Pass | Fail / cancelled / skipped | Approximate duration |
|---|---:|---:|---:|---:|
| PATH Node **v24.20.0**, `node run-offline-tests.cjs` | 94 | 94 | 0 / 0 / 0 | 4.123 s |
| Managed Node **v22.22.2**, explicit executable + in-process runner | 94 | 94 | 0 / 0 / 0 | 4.335 s |

The final suite comprises [adapter tests](<../adapter.test.js>) 34, [configuration tests](<../config.test.js>) 6, [import/diagnostic tests](<../bridge.test.js>) 2, [Windows launcher tests](<../launcher.test.js>) 4, [logger tests](<../logger.test.js>) 6, [server fixtures](<../server.test.js>) 28, and [SSE/body fixtures](<../sse.test.js>) 14. Counts describe offline test cases (containing multiple assertions), not 94 real provider/client checks.

All **14 JavaScript/CommonJS source/test files** passed syntax checks on both exact runtimes. The documentation owner independently repeated those syntax checks and observed v22.22.2/v24.20.0. PowerShell parsed the [launcher](<../start-bridge.ps1>) AST successfully; the Lead also reported `git diff --check` passed, with informational Windows EOL conversion warnings only. Hosted CI, Linux execution and other Node versions are not claimed run.

Documentation checks passed: internal file links resolve, the [disposition table](<review-disposition.md>) includes F01–F21 exactly once, and the actual dotenv/config parser validates the [placeholder template](<../.env.example>) using an explicit empty environment with alias `gpt-6-local`, Luna, port 8787, `store:false` and image capability disabled. No production environment file was loaded for these checks.

## Commands actually run / reproducible offline checks

Run from the repository root. These commands do not start the production bridge. The in-process runner imports explicit test fixtures; launcher tests use isolated environment files, loopback health probes and an inert runtime-argument shim.

```powershell
# Final full suites reported by the Lead:
node run-offline-tests.cjs
& 'C:\Users\yefan\.workbuddy\binaries\node\versions\22.22.2-6\node.exe' .\run-offline-tests.cjs

# Syntax checks independently repeated by the documentation owner:
$node22 = 'C:\Users\yefan\.workbuddy\binaries\node\versions\22.22.2-6\node.exe'
$node24 = 'C:\Program Files\nodejs\node.exe'
$sourceFiles = @(Get-ChildItem -File -Path *.js,*.cjs)
foreach ($nodePath in @($node22, $node24)) {
  & $nodePath --version
  foreach ($sourceFile in $sourceFiles) {
    & $nodePath --check $sourceFile.FullName
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
}

# AST-only check; do not execute application startup:
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $PWD 'start-bridge.ps1'), [ref]$tokens, [ref]$parseErrors
) | Out-Null
if ($parseErrors.Count -gt 0) {
  $parseErrors | ForEach-Object { Write-Error $_.Message }
  exit 1
}

# Final diff whitespace check reported by the Lead:
git diff --check
```

The [CI workflow](<../.github/workflows/test.yml>) is configured for Windows/Linux Node 22/24 with normal `node --test *.test.js`, source syntax checks and Windows AST parsing. That configuration is not evidence that hosted CI or default-isolation tests completed in this confined environment.

## Boundaries and intermediate failures

- **Historical baseline probes:** the complete external review describes **13 isolated probes confirming original defective behaviors** against baseline commit `955b8112a7b58b89e7f949dcb0696cf6ac93efa2`. The Lead also reran the supporting harness **before editing**: all 13 confirmed, with zero network calls and zero project writes reported by its output. The harness stubbed environment/log/network/listener startup. These are baseline defect reproductions, not 13 passing desired-behavior regression tests, and were not rerun after the refactor as desired acceptance. The new pure/injected fixtures replace their purpose.
- **Initial default test runner:** the exact command `node --test config.test.js logger.test.js` hit the documented confined Windows child-stdio-pipe `EPERM` boundary (the surrounding invocation also had preceding syntax checks and a following metadata query). This was an environment isolation failure, not an Azure error or a passing test run. No escalation or paid-call workaround was used. Hosted CI retains default test-file isolation.
- **Node 22 flag correction:** `--test-isolation=none` works on the locally tested Node 24 but the managed Node 22.22.2 rejected it as a bad option. The [in-process runner](<../run-offline-tests.cjs>) was added and used for both final complete runs. Node 24 can additionally use `node --test --test-isolation=none *.test.js` in a confined environment; no claim that this option works on the tested Node 22 is made.
- **Optional Foundry-skill dependencies:** the local Foundry skill dependency check exited **1** because `azd` was absent. Nothing was installed and no Azure authentication/deployment operation was attempted. The bridge and public documentation research do not require Azure CLI/SDK installation.
- **Intermediate integration fixtures:** pre-integration runs occurred while modules/fixtures were incomplete. Intermediate fixture failures and audit findings included safe header credential echoes, uncancelled rejected bodies, terminal/done consistency, normalized diagnostics and bounded finish delivery; they were corrected and covered by the final suites. Earlier partial counts/failures are not the release snapshot; the authoritative result above is 94/94 on each exact runtime.

The following **historical/boundary commands** were run by the Lead; they are not the final release checks above. The probe command was executed against the original baseline before editing and should not be treated as a desired-behavior suite for the refactor:

```powershell
node 'C:\Users\yefan\Documents\ObsidianVault\azure-bridge-review-probes.cjs'
node --test config.test.js logger.test.js
```

A documentation-check command also initially failed PowerShell parsing because of nested quoting, before executing Node; the literal here-string correction then passed all documentation/status/link/template checks, launcher AST and diff whitespace checks. This was a checker-command issue, not a source/test regression or Azure call.

## Scope and production-file distinction

The documentation owner modified only [README](<../README.md>), this docs directory, the [placeholder template](<../.env.example>) and the [CI workflow](<../.github/workflows/test.yml>). Adapter/server/config/launcher and focused tests were coordinated with their assigned owners. The Lead's final diff review found only the authorized source/test/docs/CI changes; ignore rules and license were unchanged.

The Lead checked **metadata only** for the private production environment file and reported it unchanged; its contents were not read. Existing production-log metadata **did change while the old bridge was left running**. Tests did not open or write that production log, and no claim is made that its bytes remained unchanged or that these metadata observations establish the writer's identity. Production secret/log contents were not used as evidence or copied into this record.

No acceptance version of WorkBuddy or actual Azure deployment/region/type was captured. Real cache hits/write charges, latency, billing, reasoning continuity and installed-client execution/cancellation remain unverified. [Compatibility](<compatibility.md>) and [F01–F21 disposition](<review-disposition.md>) describe local supported behavior and those residual boundaries.
