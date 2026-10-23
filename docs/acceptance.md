# Acceptance plan — approval required, not executed

This is a proposed acceptance procedure, **not evidence of Azure or WorkBuddy compatibility and not authorization to make paid requests**. Implementation and CI use synthetic fixtures and loopback mocks. No Azure calls, credentials, WorkBuddy invocation, scheduled-task installation, or real tool execution were used to prepare this patch. Historical review probes reproduced defects; they are not passing desired-behavior tests.

## Approval gate

Before a person runs any real check, separately approve: the exact Azure resource origin, deployment/variant/version and deployment type; permitted sanitized prompts and tools; number of calls and maximum output tokens; a currency budget and stop condition; installed WorkBuddy version/build and OS/Node version; listener IP/port, approved client network/firewall exposure and TLS trust; log/evidence location and deletion policy. Do not put a key or local bearer token into a fixture, screenshot, commit, or report. No automated retry should be used for these POSTs. Never execute a generated call simply because its payload is present.

An approval should name which rows below are authorized. Running the offline suite does not approve these rows. This document contains no ready-to-run paid-call command.

## Current evidence boundary

| Environment or behavior | Evidence status |
|---|---|
| Node 24.20.0 and 22.22.2 / Windows | Historical main-branch isolated offline suites 131/131 each; syntax checks and launcher AST passed. These results do not validate the Linux/shared-core merge or real acceptance; subsequent checks are separate in the [validation record](<validation.md>) |
| Other Node 22/24 releases / Windows and Linux | CI matrix configured; hosted CI, Linux and other runtime execution not claimed |
| Installed WorkBuddy version and wire fixtures | Not captured or verified |
| Azure resource, region, deployment type, effective variant/version | Not queried or verified |
| GPT-6 limits/efforts/cache schemas | Official public documentation fetched on 21 October 2026; documentation is not deployment evidence |
| Real latency, cache hits/write charges, output quality and price | Not measured; no cost guarantee |
| Scheduled task or desktop shortcut | Not installed or inspected by this patch |

## Proposed real-check matrix — separate approval required

Record each row as `not run`, `pass`, `fail`, or `inconclusive`, with the authorized environment, sanitized observation, and correlation ID. A permissive mock never establishes a deployment pass.

| Area | Check after separate approval | Required observation / stop condition |
|---|---|---|
| Routing | Confirm configured alias resolves to intended GPT-6 deployment/version; request unknown alias locally | No upstream request for unknown aliases; Azure model identity and selected profile recorded separately |
| Effort/mode/context | Try allowed efforts and approved modes on that exact deployment; explicitly compare supported `none` and absent effort | Effective reasoning returned where available; disputed sampling combinations remain gated unless verified; `all_turns` cannot restore missing state |
| Instructions | Capture a sanitized installed-client request with repeated/late system or developer content | Chronology/block boundaries preserved; mixed-role policy is explicit and has no invented textual tags |
| Tool contract | Harmless deterministic function with optional/nested arguments, explicit/omitted strictness, parallel calls and several rounds; verify terminal-buffered call timing | WorkBuddy executes only complete valid calls and correlates results; buffered tool latency is acceptable; no native cloud tool implied by function compatibility |
| Incomplete/filter safety | Small approved output cap and filtered/refused response | `length`/`content_filter` outranks tool presence; client does not execute truncated calls; refusal remains machine-readable |
| Structured output | JSON object and strict schema, including a refusal; sanitized citation extension if used | Client distinguishes JSON/schema content from refusal; exact schema semantics enforced by provider. Flat Responses citation offsets are not assumed to index merged Chat content or match WorkBuddy rendering |
| Streaming | Ordinary and long output, actual typed SSE framing, terminal reconciliation | One terminal/DONE; final usage retained within chosen limits; no duplicate text/arguments |
| Cancellation | Stop in WorkBuddy during header wait, stream read and tool work | Upstream aborted, handlers/readers cleaned up, no later tool execution; distinguish user cancellation from gateway timeout |
| Errors | Approved provider validation error and observed throttling, without deliberately flooding | Safe error `param`, retry advice and request IDs survive; no automatic retry after text/tool emission |
| Limits | Representative large document/code under chosen request/line/event/body/total/concurrency bounds | Measure bytes and memory separately from tokens; reject over-limit work predictably; do not claim full 922k input on a small byte cap |
| Operations | Foreground direct Node (or Windows loopback-HTTP launcher), identity check, shutdown and separately authorized scheduler/systemd recovery | Correct executable/config identity; same-port impostor not accepted; bounded shutdown; indefinite/restart/no-overlap or systemd timeout/umask/log mode confirmed; LAN firewall/public-endpoint exposure and client TLS trust verified |

### Cache experiment (Standard deployments only)

Approve a small fixed number of requests with a stable rendered prefix of at least 1,024 tokens, fixed tool/schema order, stable non-secret `prompt_cache_key`, and a changing final user suffix. Compare implicit policy with deliberately placed explicit breakpoints. Include explicit mode with no breakpoints to confirm its no-cache/no-cache-write semantics. The first request may write with zero reads; repeat several times rather than treating one miss as proof caching is disabled.

Record raw provider input/output/reasoning/cache-read/cache-write counters (including zero and absence), effective cache options, time to first visible text and total duration, deployment type, and the applicable Azure pricing/version assumptions. Reconcile with Azure billing; do not assume writes are disjoint from ordinary input or subtract them mechanically. A matching key is not a guaranteed hit; >approximately 15 requests/minute for one prefix/key may route differently. Cache writes may add charges. Conversion into Responses does not inherently disable caching.

For PTU-M, do not test breakpoints or explicit no-cache policy as if supported. Automatic caching remains available; cache-write counters are absent. Validate the bridge's local policy rejection without a paid call first.

## Continuity acceptance is a separate future feature

The current bridge is stateless Chat-history replay. It has no stored-response chain or opaque reasoning sidecar. Before any continuity implementation is enabled, establish a reliable authenticated client conversation ID **and branch/history identity** from actual wire evidence; extension round-tripping and timing are not proof of identity.

A future design must scope state by authenticated principal, conversation, branch, Azure origin/deployment/variant/version/profile and tool contract; retain exact opaque reasoning/phase/compaction/output items; correlate call IDs; serialize updates or compare-and-swap each branch; deduplicate history and retries; bound total and per-conversation bytes/items/count and TTL; handle response-ID expiry, eviction, restart, cancellation, model/profile changes and missing state safely. Log no opaque state. Define at-rest protection/deletion if state persists. Stored chaining requires deliberate storage consent and provider deletion/retention handling; opaque replay can use `store:false` but still sends inference to Azure.

The [concrete continuity proposal](<compatibility.md#concrete-gated-continuity-proposal--not-implemented>) specifies logical (not final header) fields `conversationId`, `branchId`, `expectedRevision`, `turnId`; auth/deployment/profile-scoped branch records; canonical exact-prefix manifests; CAS reservations; mutually exclusive stored chains or full opaque replay; and proposed 409 conflict / 410 state-gone recovery. Its illustrative bounds (8 active branches, 16 MiB per branch, 64 MiB total, 30-minute TTL, LRU eviction) are **not implemented defaults** and require workload measurements. No current request accepts those continuity fields; no installed WorkBuddy support is assumed.

Required future tests: reasoning→parallel functions→outputs→several rounds, two simultaneous tasks, history edit/fork, out-of-order concurrent responses, branch CAS conflict, duplicate turn ID with same/different payload, stale call IDs, expiry/eviction/restart/provider-ID expiry, deployment/profile switch, no duplicated inputs or provider generation, deliberate resynchronization and cross-auth isolation. Verify tool execution/delivery deduplication separately; returning a cached generation is not proof a tool cannot execute twice. Never keep one global `previous_response_id`, combine complete Chat history with chained history, infer a session from timing, or treat `reasoning_content` summaries as opaque reasoning. Async tools, WebSockets/mid-turn steering and `configuration_update` are separately deferred and require their own client/provider approval and tests.

## Evidence record template

```text
Status: NOT RUN (change only after an authorized check)
Approval reference / permitted matrix rows:
Repository commit and offline test summary:
Windows / Node / WorkBuddy exact versions:
Azure origin (redacted if needed), deployment alias/name, variant/version/type:
Profile overrides and disputed combinations approved:
Call count, output caps, budget, stop condition:
Sanitized fixture/evidence location and retention deadline:
Provider correlation IDs and raw usage (no credentials/prompts/tool arguments):
Observed result, exceptions, unresolved gaps:
```

See [compatibility](<compatibility.md>) for the implemented contract and [review disposition](<review-disposition.md>) for offline coverage versus deferred work.

## Live verification harness — Chat probe not run, native capture run once

The guarded Chat probe has not been run. The single-probe procedure, approval fields, environment variables, exact step order, rollback and sanitized evidence skeleton are documented in [live verification](<live-verification.md>). The harness refuses without every approval guard and was only checked on its refusal path; this acceptance plan does not authorize spending, an Azure call, or a service restart. `capture-native.cjs` exists for the native route; it was run once under the approval recorded in the next section, and its six shape results are listed there.

## Native capture run — 2026-10-23

An authorised native capture run was made once on 2026-10-23 under approval reference `approved-yefan`. It reached Azure only through the local bridge; the approved route was alias and deployment `gpt-6-luna`, variant `gpt-6-luna`, declared version `2026-09-22`, deployment type PAYG. Each of the six sanitized captures in `test-fixtures/azure-responses/captured/` records that same approval reference.

| Shape | Status | Observation |
|---|---|---|
| `flat-error` | `inconclusive` | `HTTP 400` with a flat `unsupported_parameter` body on `include`; no SSE `error` event was produced for the pre-flight validation failure, so the flat SSE error event remains unobserved. |
| `reasoning-nullable-summary` | `inconclusive` | No reasoning item appeared in the stream for a one-word answer, and an item-level null summary was never observed. |
| `annotations-null` | `inconclusive` | Only `annotations: []` and `logprobs: []` were observed; an explicit `null` was not. |
| `image-streaming` | `fail` | `HTTP 400`: `imagegen deployment must be provided through header: x-ms-oai-image-generation-deployment`. The header is now configurable per alias (`nativeHeaders`) but was not configured for this run, so the shape is still outstanding. |
| `output-boundary` | `pass` | `max_output_tokens:128000` was accepted with `HTTP 200` and usage `input_tokens 13`, `output_tokens 18`, `reasoning_tokens 11`. |
| `multi-call` | `pass` | After `name` was made optional on `response.function_call_arguments.done`, the same request produced 11 events and two function calls (`probe_a`, `probe_b`) with terminal status `completed`. |

This run does not constitute general Azure acceptance. It does not cover quota, latency, cache savings or price, and the rows in the proposed real-check matrix above remain unchanged.
