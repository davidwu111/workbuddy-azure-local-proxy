# Staged compatibility plan — WorkBuddy 5.8.3

Status: **stages 1–4 implemented and offline-tested; stages 5–7 gated.**

The adapter is a compatibility shim: WorkBuddy Chat Completions request → local
`/v1/chat/completions` → Azure GPT-6 Responses → Chat Completions response. This
plan replaces per-field guesswork with an explicit four-way classification and a
privacy-safe failure record. It does not add a new framework or state store.

## Why staging was needed

Two consecutive WorkBuddy 5.8.3 requests failed locally with
`400 Unsupported field: messages[N].<property>`:

1. `messages[1].startsNewUserRequest`
2. `messages[1].agent`

Both were rejected by the bridge's handwritten allowlist before any Azure call.
Neither property is part of the standard Chat Completions schema; the client adds
them. The same allowlist also rejected several *standard* Chat forms, including
nullable defaults, omitted assistant content with tool calls, `strict:null`, and
`tool_choice:"auto"` with no tools. Fixing only the reported names would leave the
next standard-form mismatch and the next client property to be discovered in
production.

## Stage 1 — Standard-schema registry (implemented)

[chat-contract.js](<../chat-contract.js>) records the current official request
fields, per-role message fields, streaming options and content types. It is a
recognition snapshot with a cited source, not a claim that every feature is
available on every GPT-6 deployment.

## Stage 2 — Four-way classification (implemented)

[adapter.js](<../adapter.js>) now classifies every field instead of accepting or
rejecting by name alone:

| Outcome | `error.code` |
|---|---|
| Mapped faithfully | — |
| Deliberately normalized inert/default form | — (logged as a field name) |
| Standard but not faithfully implementable here | `unsupported_parameter` |
| Not standard and not an approved extension | `unknown_parameter` |
| Malformed type/range for a recognised field | `invalid_parameter` |

A field is never "allowed and then dropped". Enabled semantic controls that the
bridge cannot honour are rejected: multi-choice, stop sequences, logprobs,
penalties, seeds, audio, moderation, service tier, retention, web search, custom
tools and non-root schemas. Nonzero or enabled values are never clamped or
replaced.

## Stage 3 — Exact default normalization (implemented)

Only forms the official schema defines as unset, disabled or non-meaningful are
normalized: nullable options, zero penalties, empty bias/stop, text-only
modalities, disabled logprobs, `include_obfuscation:false`, no-tool
`tool_choice:"auto"`/`parallel_tool_calls`, omitted assistant content with tool
calls or refusal, and nullable `strict`. `store:null` resolves to the declared
`store:false` policy rather than enabling provider storage by default.
`prompt_cache_key:null` clears a configured key instead of resurrecting it.

## Stage 4 — WorkBuddy extension policy (implemented)

Observed WorkBuddy 5.8.3 message-level extensions, each validated then ignored:

| Field | Validation |
|---|---|
| `startsNewUserRequest` | Boolean only |
| `agent` | Bounded opaque JSON (64 KiB, depth 16, 4096 nodes, no accessors/cycles) |
| `conversationRequestId` | Bounded opaque JSON (observed as a string) |
| Observed in later 5.8.3 sub-agent traffic | `messageId`, `model`, `requestModelId`, `requestModelName`, `rootRequestId`, `stepSeq`, `traceId`, `reasoning`, `isSubAgent`, `usage`, `rawUsage`, `argumentsDisplayText` — absorbed as bounded opaque JSON by `auto` mode |

None is forwarded, and none acquires routing, authorization, provider metadata or
conversation identity. This is a deliberate, tested exemption; it is not
permissive unknown-field handling, and `body.agent` remains an unknown field.

The set is **configurable** through `BRIDGE_CLIENT_METADATA_FIELDS` (JSON array,
≤16 names), so a future client build does not require a code change. Safety rails:

- each name must be a plain 1–64 character identifier (no dots/brackets);
- a name may never collide with a standard or bridge-reserved message field
  (`content`, `tool_calls`, `tool_call_id`, `role`, `name`, `audio`,
  `function_call`, `refusal`, `reasoning_content`, `phase`), so configuration
  cannot widen validation into request semantics;
- removing a name re-enables rejection for it;
- the effective list participates in the public `configId`.

### `clientMetadataMode` — bounded absorption of new annotations

Observed live: after a successful streaming tool call, WorkBuddy sent a follow-up
whose tool messages carried further nonstandard keys, each rejected one per turn.
`BRIDGE_CLIENT_METADATA_MODE` controls that class generally:

| Mode | Behaviour |
|---|---|
| `auto` (default) | Any *non-standard* message-level key not otherwise listed is validated as bounded opaque JSON, ignored, and logged by name in `normalizedFields`. Any key up to 128 characters is absorbed regardless of characters used — observed namespaced (`wb.subagent.children`, `workbuddy:step`) and unusual (`$ref`, spaced) keys all qualify; only length is bounded |
| `strict` | Only the configured names are ignored; anything else is `unknown_parameter` |

`auto` cannot absorb semantics, because it never applies to:

- **standard message fields** — `name`, `audio`, `function_call`, `refusal`,
  `tool_calls`, `tool_call_id`, `content`, `role` still fail as
  `unsupported_parameter` where unimplemented;
- **bridge-reserved fields** — `reasoning_content`, `phase`;
- **top-level request fields** — unknown keys, `conversation`,
  `previous_response_id` and similar remain rejected;
- **malformed metadata** — non-JSON, accessors, cycles, or over the size cap.

Every absorbed key is reported in `normalizedFields`, and a rejection still names
the exact key via `validationKey` (control characters masked). That keeps the
behaviour observable rather than silent. Residual risk: an unknown message key
that *did* carry semantics would be ignored; the recorded name is the signal to
review it.

## Stage 5 — Privacy-safe failure telemetry (implemented)

[diagnostics.js](<../diagnostics.js>) projects only fixed vocabulary: stage,
`invalid_request_error`, a bounded error code, a sanitised protocol parameter
path (unknown identifiers collapse to `<unknown_field>`), and the JSON *type* at
that path. Bodies, messages, values, identifiers, schemas and upstream error text
are never persisted. A value exceeding 64 KiB is rejected validation, so the
diagnostic never needs to serialise large input.

## Stage 6 — Offline verification (implemented)

Regressions cover the two reported fields, standard nullable defaults, nonnullable
options, inert-versus-enabled controls, every unsupported semantics branch,
assistant omission, nullable strictness, no-tool controls, both streaming modes,
and telemetry redaction including accessor and marker-string adversarial fixtures.
Results are recorded in [validation](<validation.md>).

## Stage 7 — Real acceptance (gated)

Not executed. Offline fixtures cannot prove that an installed WorkBuddy 5.8.3 and
the configured Azure deployment agree on SSE framing, usage chunks, cancellation,
tool execution or reasoning summaries. Use the approved matrix in
[acceptance](<acceptance.md>) with sanitised dummy content and explicit budget
approval. Capture a failing request's logged `validationParam`/`validationValueType`
instead of its body.

If a future WorkBuddy build introduces a new client property, `auto` mode already
absorbs it as logged message metadata, and `strict` plus `validationKey` names it
exactly. Standard fields should still be added by mapping, not by widening the
extension list.

## Activation

The merged Linux/shared-core build identifies itself as `adapter-v2.10-linux`. It takes effect only in a newly
started process. The launcher refuses to reuse an older build and never replaces a
running one automatically; stop the old bridge explicitly before starting again.
