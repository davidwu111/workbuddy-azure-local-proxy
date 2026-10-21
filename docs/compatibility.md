# Implemented compatibility contract and official evidence

This is a **supported subset**, not transparent Chat/Responses pass-through. The [pure adapter](<../adapter.js>) accepts validated Chat Completions requests and translates them into stateless Azure Responses requests. The [configuration module](<../config.js>) determines the route and capability gates. Official documentation establishes schema intent; offline fixtures establish local conversion behavior; neither establishes real Azure/WorkBuddy acceptance. See the [separate approval-gated plan](<acceptance.md>).

## Profiles and official evidence

Public sources were fetched on **21 October 2026** without credentials or inference calls. Azure deployment name is separate from the underlying variant and declared version. The bridge requires that distinction; it does not discover or verify an Azure deployment. Any nonempty bounded declared version is accepted as an operator assertion, not checked against a live registry.

| Variant | Azure documented version | Locally allowed effort values |
|---|---|---|
| `gpt-6-astra` | `2026-09-03` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-6-sol` | `2026-09-22` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-6-luna` | `2026-09-22` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-6.1-sol` | `2026-09-29` | `low`, `medium`, `high`, `xhigh`, `max` |

Sources: [Azure Responses supported models](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses#supported-models), [Azure reasoning support](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning#api-and-feature-support), [OpenAI Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), and [6.1 Sol/migration guidance](https://developers.openai.com/api/docs/guides/latest-model).

All four are documented with text/image input and text output, 1,050,000-token context, 922,000 maximum input and 128,000 maximum output. Input, reasoning and output share context; limits are **not independently additive**. The local adapter does not tokenize the input or promise that its byte limits admit the entire model window. `max_output_tokens` includes reasoning, visible output and formatting tokens. `minimal` is not in these GPT-6 profiles. `max` uses Responses. Astra/6.1 Sol require Responses for tools; Sol/Luna Chat tools require `none`. This bridge always uses Responses upstream.

### Conservative gates and documentation conflicts

Microsoft's GPT-6 summary table marks `none`, sampling and logprobs supported across all variants; its later unsupported-parameter prose and OpenAI's detailed migration guidance disagree. Therefore this project does not copy those family-wide booleans as an unconditional Azure contract. The baseline allows sampling only with explicit effective `none` on Sol/Luna, rejects logprob controls, and allows only standard reasoning mode until an operator profile enables more. OpenAI-hosted support is **not** proof of support on an Azure deployment. Expansion of disputed capabilities requires separately approved deployment verification, even when the configuration accepts the assertion.

Baseline profile and permitted overrides:

| Profile key | Baseline / validation |
|---|---|
| `efforts` | Variant-specific list above; override may restrict but not add unsupported variant efforts, and cannot be empty |
| `defaultEffort` | Absent; optional value must be in that route's allowed efforts |
| `samplingEfforts` | Sol/Luna: `["none"]`; Astra/6.1 Sol: `[]`. Override may list valid allowed efforts as an **operator-verified assertion**, not automatic detection |
| `reasoningModes` | `["standard"]`; explicit override can include `pro` |
| `reasoningContexts` | `["auto","current_turn","all_turns"]`; override can restrict |
| `maxOutputTokens` | 128000; override must be positive and ≤128000 |
| `images` | `false`; optional explicit gate, still no client/deployment acceptance claim |
| `verbosity` | `true`; optional boolean gate |
| `cacheBreakpoints` | `true` for pay-as-you-go; forced false on PTU-M; explicitly enabling it on PTU-M is invalid |
| `deploymentType` | `"payg"` or `"ptu-m"`; default `"payg"` is an operator declaration, not resource discovery |

Single route uses JSON `BRIDGE_MODEL_PROFILE`; multiple routes use each `BRIDGE_MODELS` entry's `profile`. Global configured reasoning defaults must be supported by **all** routes. For example, enabling pro mode requires both a route profile containing `pro` and a request/default selecting it; setting a default alone does not bypass the gate.

The [Azure creation reference](https://ai.azure.com/api-reference/llm/responses/create-response.md) verifies generic `reasoning.mode=standard|pro`, `context=auto|current_turn|all_turns`, and summaries `auto|concise|detailed`. Generic schemas include efforts not supported by every model; that is not permission to accept all enums for every route. Azure's reasoning guide states standard is its default and GPT-6 defaults to all-turns context when compatible earlier reasoning items are available. Selecting `all_turns` does not create missing items.

## Request-field policies

The adapter now starts from the **official Chat Completions request schema** rather than a handwritten allowlist. Every standard field is *recognized* and classified into one of four outcomes; recognition does not imply the GPT-6 Responses target can faithfully implement it.

| Outcome | `error.code` | Meaning |
|---|---|---|
| Mapped faithfully | — | Converted to the Responses equivalent with unchanged intent |
| Deliberately normalized | — | Documented, tested default/inert form (see below); logged as a field name |
| Standard but unsupported | `unsupported_parameter` | A valid Chat semantic this bridge/deployment cannot represent; rejected, never dropped |
| Unknown / nonstandard | `unknown_parameter` | Not part of the standard schema and not an expressly supported extension |

Malformed standard values (wrong JSON type, out-of-range number, empty required array) remain `invalid_parameter`. This keeps the actionable distinction between "you asked for something we cannot do", "that value is invalid", and "that field is not part of this protocol".

### Deliberately normalized defaults

Only forms that the official schema defines as *unset*, *disabled*, or non-meaningful are normalized. Nonzero/enabled controls are never discarded.

| Input form | Normalization |
|---|---|
| `null` for a standard nullable option (`stream`, `n`, budgets, `temperature`, `top_p`, `metadata`, `store`, `reasoning_effort`, `verbosity`, …) | Treated as unspecified; configured/declared defaults apply |
| `frequency_penalty: 0`, `presence_penalty: 0` | Omitted (documented inert value) |
| `logprobs: false` with no `top_logprobs` | Omitted (disabled) |
| `logit_bias: {}` | Omitted (no biases) |
| `modalities: ["text"]` | Omitted (default text-only) |
| `stop: []` | Omitted (no sequences) |
| `stream_options.include_obfuscation: false` | Omitted (disabled); `true` is unsupported rather than silently discarded |
| `tool_choice: "auto"` with no declared tools | Target `none` (no tools available) |
| `parallel_tool_calls` with no declared tools | Applicability no-op, omitted |
| Assistant content omitted with `tool_calls`/`refusal` | Accepted, matching the standard schema |
| `strict: null` on tools / `json_schema` | Resolved to explicit target `strict:false` (Chat's nonstrict default) |

`top_logprobs: 0` is **not** an unconditional no-op: the standard requires `logprobs:true` whenever it is used, and that still requests sampled-token probabilities. `prompt_cache_key: null` omits the key even when a bridge default is configured, so it cannot resurrect cache identity the caller cleared. `prompt_cache_retention` and `prompt_cache_options.ttl` express independent maximum/minimum policies and are never substituted for one another.

### Standard fields that are recognized but rejected

These are valid Chat Completions semantics that this bridge does not implement faithfully, so they fail locally with `unsupported_parameter` instead of being silently ignored: `n>1`, nonempty `stop`, nonzero penalties, nonempty `logit_bias`, `logprobs:true`/`top_logprobs`, `seed`, `audio`, non-text `modalities`, `prediction`, `moderation`, `service_tier`, `prompt_cache_retention`, `web_search_options`, legacy `functions`/`function_call`, legacy `function` messages, custom tools and custom/allowed-tools `tool_choice`, non-root-object JSON schemas, image input when the profile disables it, and image `detail:"original"`.

### Field table

| Chat field | Implemented behavior |
|---|---|
| `model` | Optional permitted alias; absent uses default alias. Empty/unknown aliases rejected. Upstream gets route deployment; outward model stays alias |
| `messages` | Nonempty array; explicit supported roles and content validation. Malformed items are rejected, never skipped |
| `messages[].name` | Standard participant name, but no inspected Responses message variant has a `name` slot. Rejected as `unsupported_parameter`; never prefixed to content or moved into metadata |
| `messages[].startsNewUserRequest` | Explicit WorkBuddy boolean hint; validated then ignored. Cannot change authority, truncate/reorder history, or establish identity |
| `messages[].agent` | Explicit WorkBuddy extension: bounded opaque JSON (≤64 KiB, depth 16, 4096 nodes, no accessors/cycles). Validated then **ignored**; never forwarded, never provider metadata, never identity or routing |
| `messages[].conversationRequestId` | Explicit WorkBuddy extension observed in 5.8.3 (string). Validated as bounded opaque JSON, then **ignored**; not forwarded, not used as a conversation, turn or idempotency identity |
| `messages[].<client metadata>` | `BRIDGE_CLIENT_METADATA_FIELDS` may extend the ignored-metadata name set (≤16 plain identifiers). Reserved/standard message names are rejected at startup, so this cannot widen request semantics. `BRIDGE_CLIENT_METADATA_MODE=auto` (default) additionally ignores any other non-standard message-level key, logging its name; `strict` rejects it with `unknown_parameter` |
| `stream` | Optional boolean, default false |
| `stream_options` | `include_usage` boolean; requires `stream:true`. `include_obfuscation:true` unsupported; `false` normalized away |
| `n` | Standard integer; only `1` implemented. `n>1` is `unsupported_parameter` |
| `tools` | Chat function tools; unique valid names. Custom tools are recognized but unsupported |
| `tool_choice` | `auto`, `none`, `required`, or named declared function. `auto` with no tools becomes `none` |
| `parallel_tool_calls` | Boolean; preserved when tools exist, otherwise an applicability no-op |
| `reasoning_effort` | Standard enum validated against the deployment profile; forwarded including supported `none`. A profile-rejected effort is `unsupported_parameter`, never substituted |
| `reasoning_mode`, `reasoning_context` | Bridge extension fields → `reasoning.mode`/`reasoning.context`; request beats global default. Raw nested `reasoning` is not accepted |
| `temperature`, `top_p` | Finite range 0–2 / 0–1 and allowed effective sampling effort required |
| `max_completion_tokens`, `max_tokens` | Positive safe integers within min(global/profile cap); `max_completion_tokens` precedence when both are supplied. Absent uses the declared cap |
| `response_format` | `text`, `json_object`, or Chat `json_schema` → `text.format`. Schema name/description/schema and explicit strictness preserved; omitted/null strictness becomes explicit false |
| `verbosity` | `low`, `medium`, `high` → `text.verbosity` if profile permits |
| `prompt_cache_key`, `prompt_cache_options` | Validated request overrides configured default; `key:null` clears it |
| `store` | Boolean; default false. True requires `BRIDGE_ALLOW_STORE=true` |
| `metadata` | Forwarded JSON object ≤16 entries, string values ≤512 characters. `metadata.agent` is ordinary provider metadata only when the caller sends it explicitly |
| `safety_identifier` | Forwarded standard identifier ≤128 characters; never derived from WorkBuddy data and never logged |
| `user` | Forwarded nonempty string ≤512 characters; not used to infer identity |

`BRIDGE_SAMPLING_POLICY=reject` is the baseline. Explicit opt-in `drop-defaults` removes **only incompatible** `temperature`/`top_p` exactly equal to `1`; other values remain errors. Allowed combinations are forwarded unchanged. Logs report only normalized field names/effective settings, not request content. This does not approve a particular WorkBuddy build's default behavior.

## Instructions, content and tools

System/developer messages stay role-bearing input items in chronological order, including late/repeated instructions and text blocks. `reject-mixed` (startup default) rejects having both instruction roles. `preserve` retains both roles, while `system`/`developer` normalizes instruction roles explicitly without reordering or text tags. Azure advises avoiding mixed system/developer instructions for relevant reasoning requests; normalization is an explicit semantic policy, not an invented precedence guarantee.

- User/system/developer strings or nonempty Chat `{type:"text",text:...}` arrays become `input_text`. Empty strings are accepted, empty arrays are not.
- Assistant text becomes `output_text`; nullable assistant content is permitted with function calls/refusal. Optional caller-provided `phase` accepts `commentary`/`final_answer` and is preserved on a representable assistant content item; call-only phase is rejected instead of dropped. It is not inferred or reconstructed from flattened provider state.
- Optional assistant `reasoning_content` is validated as display text and **ignored on replay**. It does not become provider reasoning. Refusal is preserved through supported assistant refusal fields/blocks.
- WorkBuddy message-level `startsNewUserRequest` is accepted only as a boolean on any supported message role and deliberately omitted from Responses input. WorkBuddy's `agent` message property is likewise accepted as bounded opaque JSON and omitted. Neither can change authority, truncate or reorder history, select a deployment/provider metadata, or establish conversation/branch identity. Other unknown fields still fail locally. The reported fields do not establish reliable conversation/branch identity, and this change does not implement continuity or prove an installed client's complete wire contract.
- User images are available only with `profile.images=true`: Chat `image_url` must be an object `{url,detail?}`, not a shorthand string. HTTP(S) URLs without embedded credentials or supported base64 image data URLs are translated without local fetching. Detail `auto|low|high` is preserved. Non-user images are rejected. **WorkBuddy image capability remains disabled pending joint verification.**
- Audio/file blocks and other modalities are rejected, even where Azure supports them. Tool results support string or nonempty text-block arrays; arrays concatenate their text without JSON-wrapper serialization. Image/file tool output is not implemented.
- Assistant function histories require unique nonempty call IDs, valid names and JSON-object argument strings. Each tool output must match an unresolved earlier call; all pending calls must be resolved before the next user/assistant turn or history end. Parallel and multi-round histories are supported within these constraints.
- Function `strict` defaults explicitly to false. True/false are preserved. Parameters require root object schemas; strict validation recursively requires `additionalProperties:false` and every property required, including nested object branches. Nullable required values express optionality. The bridge does not mechanically rewrite optional fields or claim to implement all Azure JSON-schema restrictions.

Azure's [Responses guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses#choose-an-image-detail-level) verifies image detail values. The [OpenAI function strict-mode guide](https://developers.openai.com/api/docs/guides/function-calling#strict-mode) says omitted Responses strictness attempts normalization while Chat defaults to non-strict; this is why compatibility defaults explicitly to false.

## Cache schema, storage and usage

Actual Azure block field: **`prompt_cache_breakpoint: {mode:"explicit"}`**. `cache_control` is not a verified Azure alias and is rejected. Validated breakpoints are preserved on translated system/developer/user `input_text` and gated user `input_image`. Assistant `output_text` breakpoints and `input_file` are rejected locally: Azure supports input-file breakpoints, but this bridge does not support file input.

`prompt_cache_options` supports only `mode:"implicit"|"explicit"` and optional `ttl:"30m"`; omitted mode uses the provider implicit default. Other properties, including schema `comparison_response_id`, are deferred/rejected. Request and configured keys both use the same 1–128 ASCII prefix-family identifier rule: start with alphanumeric, followed by alphanumeric or `._:-`. This excludes freeform/secret-like key content from ordinary diagnostics. Operators must not supply secret/PII keys. No new random key or automatic explicit breakpoint is generated.

The [Azure caching guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/prompt-caching) and [creation reference](https://ai.azure.com/api-reference/llm/responses/create-response.md) verify:

- GPT-5.6 and later, including GPT-6, use options mode and `ttl:"30m"`; it is the documented default and only supported minimum lifetime. TTL is not a maximum retention or ZDR promise. `prompt_cache_retention` does not apply/is deprecated for these models.
- ≥1,024 identical rendered prefix tokens are required. The key improves matching/routing; unchanged key alone does not guarantee hits. Tool/schema/detail changes can change the prefix.
- Standard implicit uses the provider's implicit latest-message boundary plus supplied explicit boundaries. Standard explicit uses only supplied boundaries; **no boundaries means no caching or cache-write charges**. Preserving that policy matters to caller cost intent.
- PTU-M has automatic caching but no explicit breakpoints or cache-write reporting. The local profile disables breakpoints and rejects explicit policy. It does not fabricate zero cache writes for an absent provider field.
- Four new write slots are documented (implicit consumes one; up to three additional explicit, versus four in explicit mode). Guide says 50 earlier read breakpoints; creation reference says 80. This conflict is recorded, not turned into a local correctness limit or a reason to insert four writes indiscriminately.
- Writes can be charged. Reconcile raw counters against model/deployment/version-specific Azure input/read/write/output pricing; do not infer price from visible output or assume writes can be subtracted as a disjoint category. No savings guarantee is made.

`mapUsage` translates `input_tokens→prompt_tokens`, `output_tokens→completion_tokens`, and preserves total and detailed cache-read/cache-write/reasoning counters including zero, nullable unrelated detail counters, and missing-field distinctions. Bounded raw numeric/null provider usage is available as `usage.azure_usage` for reconciliation, including missing/nullable detail distinctions. It is not itself a price estimate; opaque/string/array usage extensions are rejected rather than copied to the client. Ordinary logs retain only allowlisted numeric counters, not arbitrary raw provider fields. Streaming exposes a choices-empty usage chunk only with `stream_options.include_usage=true`.

`store:false` is explicit by default. Azure's [creation reference](https://ai.azure.com/api-reference/llm/responses/create-response.md) defaults storage to true; its [Responses guide](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses#delete-a-response) describes 30-day default response retention. Allowing storage here does not implement retrieval/deletion/chaining; consent and provider retention handling remain the operator's responsibility. Computation caching and response storage are distinct. Inference leaves the machine even with storage disabled.

## Returned content and tool safety

Both modes use one terminal-status policy. Completed responses can expose validated function calls. Incomplete `max_output_tokens` yields `length`; incomplete `content_filter` yields `content_filter`; these outrank tool presence and suppress calls. Unknown/missing statuses, failed/cancelled/queued/in-progress responses and unknown incomplete reasons do not become a normal empty completion. Function calls with missing/duplicate IDs, malformed JSON-object arguments or noncompleted call state are not advertised as executable. A completed parent containing only invalid/duplicate/noncompleted calls returns 502; mixed output can retain valid completed calls while suppressing invalid ones and returning `bridge_warnings: ["suppressed_invalid_or_incomplete_tool_calls"]`. A completed parent with an unfinished material message/function child uses `length` while retaining only valid completed calls; a child `content_filter` outcome uses `content_filter` and suppresses all calls. Unknown material child statuses return 502. Globally incomplete parents suppress all calls. This is protocol safety, not proof that an installed client obeys finish reasons or a full tool-permission system.

Output text is returned as content. Refusal has a machine-readable `message.refusal` plus content fallback when there is no ordinary text. Provider summary text can become `reasoning_content`; raw reasoning/encrypted items are never shown as summary or retained in a sidecar. The `annotations` extension preserves only flat Responses-shaped bounded `url_citation`/`file_citation` identity/text/index fields; unsafe citation URLs are rejected and unknown annotation types/fields are dropped. Citation offsets remain the original Responses offsets: flattening multiple output messages does not rebase them into one global Chat content string. This is not a verified WorkBuddy citation-rendering contract. Provider content filters use sanitized `azure_content_filters` with known categories, flags, severity/source and indices only; unknown fields are dropped. Multiple message phases/item identities/compaction state cannot be fully round-tripped by flattened Chat output. Unknown output types are rejected rather than silently claimed compatible.

## Stateless continuity boundary and deferred architecture

No authenticated state store, response-ID chaining, opaque replay, conversation sidecar, compaction reconstruction or guessed WorkBuddy session exists. Each request replays supplied Chat history with `store:false` unless explicitly opted in. `reasoning.context=all_turns` alone cannot restore the opaque items removed by Chat conversion. Summary display is not reasoning continuity; this is a documented architectural limitation, not a claimed universal Azure error or inevitable higher cost.

Azure [persisted reasoning guidance](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning#preserve-reasoning-across-calls) requires earlier compatible items reachable via stored response chains, conversation, or complete replay. Opaque items can be returned with `store:false`; full replay is still not implemented here. If added later, retain original phases/compaction/items without extracting hidden reasoning, and gate by verified authenticated conversation/branch identity, concurrency bounds, TTL/expiry/eviction, model/deployment/profile scope and deduplicated inputs. Never combine full Chat history with chained history or maintain one global previous-response ID. The [acceptance plan](<acceptance.md#continuity-acceptance-is-a-separate-future-feature>) contains required design/branch/isolation tests.

### Concrete gated continuity proposal — NOT implemented

The following is an illustrative future design, **not current accepted request fields, current status-code behavior, or verified WorkBuddy support**. The actual client must first demonstrate persistent identity/extension delivery for its exact build. Logical fields `conversationId`, `branchId`, `expectedRevision`, and `turnId` could be carried by agreed headers/extensions; header names are intentionally **not final**. A caller's arbitrary claimed ID never replaces authenticated identity.

```text
verified client identity + auth scope + deployment/profile
                         |
     lookup (principal, origin, deployment, variant/version,
             profile/tool-contract hash, conversationId, branchId)
                         |
   verify expectedRevision + exact canonical Chat prefix + turnId
             / mismatch        / missing or expired
       409 branch conflict       410 state gone
             |                         |
      explicit edit/fork        deliberate stateless resync
                         |
       reserve turn with branch compare-and-swap
                         |
     exactly one provider POST (no automatic retry)
                         |
       commit complete retained output + new manifest
                         |
    deliver result; advance branch revision atomically
```

Illustrative internal record (never emitted in health/logs):

```text
key: authenticatedPrincipal + azureOrigin + deployment + variant/version
     + profile/toolContractDigest + conversationId + branchId
revision: integer
mode: storedChain | opaqueReplay (mutually exclusive)
providerResponseId: only for storedChain
opaqueOutputItems: complete reasoning/phase/compaction/function/message items,
                   only for opaqueReplay; never display-summary substitution
historyManifest: canonical Chat prefix digest(s) + message/item counts
                 + tool/call associations, needed to verify exact history
turns[turnId]: canonical request digest + pending/committed outcome
              + committed revision/result reference (bounded)
expiresAt / lastAccess / byteCount / pendingOwnership: bounded internal state
```

The manifest is internal integrity data, scoped to auth/branch, not a cache key or log of prompts. Canonicalization must include all semantics affecting history (roles, ordered blocks, phase/refusal, tool IDs/arguments/results and tool contract) and verify the exact committed prefix before accepting an appended suffix. Do not infer identity from timing, a similar prefix, or unverified user/metadata fields. Keep provider opaque items separate from visible Chat equivalences so they are never replayed twice.

Proposed request flow:

1. Authenticate, select the approved deployment/profile and verify conversation/branch fields. Resolve and lock/reserve the expected branch revision with compare-and-swap; concurrent stale revisions fail explicitly instead of sharing a provider chain.
2. Check expiry and stored-provider-ID validity. Unknown branch after restart, eviction, local TTL or provider expiry yields proposed **410 state gone** and requires a deliberate stateless resynchronization/new identity; never silently guess or attach another branch. Edited/mismatched prefix or wrong revision yields proposed **409 branch conflict**, requiring an explicit new branch/fork or correction.
3. Bind `turnId` to branch, authenticated scope, request digest and revision before POST. Reusing a turn ID with different content fails. A pending/committed duplicate must not start another generation; expose the existing outcome/reference only under a verified delivery/idempotency protocol. Do not blindly replay tool-bearing output to an unverified client, because generation deduplication alone does not prevent duplicate tool execution. Failed/unknown delivery stays explicit; no automatic POST retry.
4. Choose exactly one continuation mode. **Stored chain:** provider storage requires explicit consent; retain `providerResponseId` and send **only verified new input suffix**, with intentional instructions/retention/deletion behavior. **Opaque replay:** retain/replay complete provider items plus new suffix, using `store:false` where appropriate; replace flattened assistant equivalents rather than adding both. Never combine complete Chat history with `previous_response_id`.
5. Retain exact complete opaque output, phase/compaction and call identity, then atomically commit manifest, turn outcome and next revision. Cancelled/incomplete/failed turns need an explicit recovery contract; do not advance an unverified branch as if completed. Release pending ownership and dispose of rejected/aborted state safely.

Example **proposal-only** bounds: at most 8 active branches, 16 MiB per branch and 64 MiB total, 30-minute inactivity TTL, with configurable measured limits and LRU eviction. Count manifests, turn results and opaque items together; use tombstone/state-gone outcomes for evictions rather than silent fallback. Provider response-ID expiry can be earlier and must also be handled. Restart loses nonpersisted state explicitly; persistence requires at-rest protection, authenticated scope, deletion and retention design. These values are not implemented defaults or Azure limits. Tests must cover two tasks, fork/edit, concurrent CAS/turn-ID races, expiry/restart/eviction, model/profile switch and no duplicated history or tools before enablement.

Async tools, WebSockets/mid-turn steering and `configuration_update` are explicitly deferred. Official GPT-6 support for these capabilities does not make them executable or permission-compatible through WorkBuddy function tools. Configuration updates preserve a prefix only in a suitable stateful request design; copying one from arbitrary stateless Chat input is not implemented.

## Transport and client evidence

The [HTTP server](<../server.js>) and [bounded body/SSE lifecycle module](<../sse.js>) have no startup/environment/log I/O on import. The executable validates configuration and starts the configured literal-IP listener (default `127.0.0.1`), with native HTTPS only when both TLS certificate/key paths are configured. Relative TLS paths resolve from the process working directory; certificate/key inputs must be readable regular PEM files no larger than 1 MiB each, with nonblocking opens before read. Check-only validates configured TLS files but opens no log/listener and does not check log writability. Public health/model endpoints are unauthenticated on every bound interface, so opt-in LAN deployment requires firewall restrictions and trusted TLS. Health `status:"ok"` identifies liveness; readiness is separately `ready` or 503 `not_ready` during shutdown. Public identity contains service/protocol/build/config ID including host/port/TLS-enabled state, not credentials or certificate/key paths/material; credential changes and TLS renewal/path changes require an explicit restart. See the [Linux deployment guide](<../LINUX.md>). The request factory uses explicit injected dependencies and owned ephemeral loopback fixtures. The local bearer must be exact visible ASCII without whitespace; startup rejects padding/non-ASCII and never silently trims it into another token. No fixture is a captured Azure event or real WorkBuddy test.

### Bodies, limits and timeouts

- Requests require `Content-Type: application/json`; wrong MIME returns 415, malformed UTF-8/JSON 400, oversized upload 413, stalled upload 408. Auth/routing/semantic validation and the default 16-request concurrency gate happen before an upstream POST; up to 32 additional requests wait for capacity (default 30 seconds), then capacity rejection is 429 with `Retry-After: 1`.
- Upstream successful HTTP status must be 200, with `application/json` in nonstream mode or `text/event-stream` in stream mode. Unsupported MIME/status/shape and invalid UTF-8/JSON fail visibly. Error bodies are bounded separately; non-JSON/malformed provider errors fall back to a generic status message rather than unbounded parsing.
- `responseBytes` independently caps total upstream bytes and encoded downstream response bytes. JSON/error body caps use the smaller of their own bound and response bound. `sseLineBytes` limits an unfinished raw line; `sseEventBytes` counts raw event lines/delimiters including CRLF. `sseBufferBytes` separately constrains active framing and retained text/refusal/summary/items. These are logical resource budgets, **not one combined process-RSS cap**; buffers, parsed objects and retained terminal output can coexist. Concurrency and workload measurements remain necessary.
- Upload, upstream header/read inactivity, downstream stall, total lifetime and shutdown use distinct positive millisecond budgets. Upstream idle is active only while awaiting upstream bytes, not while deliberately draining the downstream. Total lifetime still applies. Header/read/drain waits are abort-aware; reader cancellation/release and listener/timer cleanup are explicit, including injected implementations that ignore abort.

### Streaming contract and intentional tool latency

Text, refusal and provider summary deltas are incremental. **Function call IDs/names/arguments are retained internally and withheld until a validated terminal response**, then emitted as complete Chat tool-call deltas. This intentionally changes tool-delta timing to prevent an installed client from executing partial arguments merely from their presence; it is not async tool calling. Validate this timing and WorkBuddy execution behavior in the separately approved client acceptance.

The parser supports fragmented UTF-8, BOM, LF, CRLF, bare CR, multiline data, comments and data-only typed records. Dispatch uses event name or payload type with conflict rejection. Malformed material JSON, unsupported material event types, orphan/conflicting tool arguments, response identity mismatch, premature DONE and truncated EOF fail visibly. Known no-op events are handled deliberately without warning spam; annotation-added events do not emit arbitrary metadata, with sanitized citations taken only from terminal output.

Done/terminal data is reconciled with emitted text and accumulated tool arguments; conflicting content is an error rather than duplicated or silently dropped text. Full terminal output is authoritative. A missing terminal output array can be reconstructed **only from explicitly done output items**, never from partial deltas. Calls must also be declared in the current request, match a forced named choice when selected, and cannot be returned when `tool_choice:"none"`. Both modes use shared terminal/status/refusal/usage mapping. Refusal's ordinary-content fallback is added only at terminal completion when there is no ordinary output text.

Normal writable streams emit one terminal finish frame, optional choices-empty usage frame only with include_usage true, then one DONE. Mid-stream failure keeps HTTP 200 but emits an OpenAI-style error plus DONE when delivery is possible. A stalled/disconnected downstream is closed/destroyed rather than hanging while guaranteeing undeliverable terminal frames. Tool warnings/content-filter metadata and safe annotations are delivered in terminal metadata.

### Errors, headers and diagnostics

Safe forwarding allowlist: `retry-after`, `retry-after-ms`, `x-ms-retry-after-ms`, `x-request-id`, `request-id`, `apim-request-id`. Values are bounded/validated; configured credential values are suppressed. Provider status/message/code/type/param are returned through a bounded envelope with known secret/origin redaction. Other headers are not forwarded. Redirects are rejected and **automatic POST retries are absent**, including after text/tool emission.

Allowlisted logs record local/upstream correlation, alias/deployment/variant/version, requested reasoning settings, normalized sampling field names, mapped finish reason/effective completed/incomplete/content_filter/partial outcome, elapsed duration and numeric usage independently of client usage opt-in. First-token telemetry is a **proxy first-emission metric**, including refusal/summary or a terminal-validated tool call; nonstream timing is completion time, not a measured native Azure TTFT. Logs cannot prove real provider latency, exact billing or installed-client handling. They have a bounded asynchronous queue, so saturation may drop records. Default limits and operation commands are in the [README](<../README.md>); values are operational byte choices, not Azure token requirements.

[WorkBuddy's model documentation](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Model) verifies Settings → Model UI and Custom Protocol's URL-only behavior. It does not specify exact extension/summary/usage/session wire behavior. The [WorkBuddy changelog](https://www.workbuddy.ai/docs/workbuddy/Changelog) changes over time; no installed build is claimed tested. Enable only the compatibility subset you can verify for the installed client. Keep `supportsImages:false` even though the provider advertises vision until the approved path is tested.
