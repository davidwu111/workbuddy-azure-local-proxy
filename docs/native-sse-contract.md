# Native Azure Responses SSE transport contract

**Status: native transport implemented; Step 3 create integration is default-off; no production activation or live Azure validation.** This layer preserves native events; it does not add a server route or enable model/tool features. Existing Chat parsing, mapping and terminal-buffered tool behavior remain unchanged. See the [approved design](<responses-api-design.md>) and [53-event inventory](<../test-fixtures/azure-responses/event-inventory.json>).

## Modules and exports

The pure [event registry](<../native-events.js>) exports:

- `EVENT_REGISTRY`: null-prototype, deeply frozen descriptors for exactly 53 documented names, their categories, required transport fields and feature-gate hints.
- `COMPATIBILITY_EVENTS`: separate `response.cancelled` handling; this does not assert Azure documents/emits that event.
- `FEATURE_CATEGORIES`: the seven specialized feature groups comprising 29 events.
- `chatPolicyForEvent(name)`, `CHAT_NOOP_EVENTS`, `CHAT_SUPPRESSED_EVENTS`: the Chat classification derived from registry categories, so the policy has one source of truth. The Azure enum snapshot date (2026-10-22) is recorded in the module header.
- `validateNativeEvent(name, payload)`: typed-object and known transport-field validation; valid future types remain nonterminal and opaque.

The [native transport](<../native-sse.js>) exports `DEFAULT_LIMITS`, `DEFAULT_TIMEOUTS`, `parseNativeSse`, `createNativeTracker`, `validateRecord`, `encodeRecord`, `NativeSseWriter`, `relayNativeSse`, `boundedLocalError`, and `redactNativeErrorRecord`.

Imports perform no configuration/credential reads, network calls, logging or listener creation. The native module reuses pure bounded byte reading, storage, drain and cancellation helpers from the [existing SSE module](<../sse.js>), without changing it.

## Frames and metadata

`parseNativeSse(chunks, limits)` yields frozen records:

```js
{ event, id, idPresent, retry, data, hasData, comments, metadata }
// metadata: ordered frozen { field, value } entries, including comments (field ':')
```

- Preserve field order, duplicates, native JSON text, multiline data, comments and metadata-only records.
- Convenience fields use the last event/id field and last valid decimal retry within the record. Explicit empty IDs remain explicit. No implicit prior-record ID is invented; the downstream SSE consumer maintains its own last-event-ID semantics.
- Preserve unknown SSE fields and invalid retry strings as ignored metadata; do not promote them into semantic events.
- Support one-byte fragmented UTF-8, leading BOM, LF, CRLF and bare CR. Encoded output normalizes delimiters and insignificant field spacing to LF; preservation is protocol-semantic, **not byte-for-byte**.
- Wire event bytes count every delimiter exactly once. Line limits apply to line content, not its delimiter.
- Invalid UTF-8, NUL/control injection, unfinished lines/records and oversized framing fail visibly. A run of empty chunks is bounded to prevent a non-progress stream.

`validateRecord(record, tracker)` adds `{ name, payload, known, terminal }`. Create the tracker with `createNativeTracker(limits)`; it is request-local and must not be shared across requests.

`encodeRecord(record, maxBytes)` safely reconstructs native frames, checking field values and the output byte budget before accumulating output. It never generates Chat chunks, `choices`, provider model substitutions, fabricated provider identities/sequences or a Chat `[DONE]` sentinel.

## Known and future event validation

The registry follows the [Azure Responses event schemas](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses#openairesponsestreameventtype), not the different AgentServer SDK enum:

- Validate each documented event's required transport fields: types, sequences, indices, IDs, text/code/refusal/input/arguments, part/annotation objects and partial-image fields as applicable.
- Audio/transcript done events do **not** require a fictitious text field. Code-interpreter code completion uses `code`; refusal completion uses `refusal`.
- `response.created` may carry `in_progress` or `queued`, not a made-up `created` response status. Other known lifecycle names must match their response status. Preserve nullable error/incomplete details.
- Flat Azure errors validate their documented outer fields. The nested error form shown by the [Azure streaming how-to](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses#streaming) is supported without inventing an absent outer sequence number.
- Empty/missing logprobs are not requested by this bridge; for compatibility, omitted `logprobs` are accepted, but a provided value must be an array. This is an explicit transport compatibility exception, not a claim of complete recursive schema validation.
- Preserve unknown extensions and future output-item types without guessing their schemas. Only documented identity fields and actually observed item lifecycles are compared.
- Known sequence numbers increase strictly, with gaps allowed. Track response identity and index-to-item-identity/type relationships; reject observed identity conflicts, repeated item IDs/starts/completions, or sequence rollback. Parallel items need not complete in index order.
- Future typed events receive only generic framing/type/size checks. Their payload fields are opaque; they cannot serve as an inferred successful terminal outcome.

This is transport-relevant validation, not complete request validation or proof of live deployment capability. It does not flatten output, interpret encrypted reasoning, reconstruct terminal output or authorize tool execution.

## Budgets and bounded state

Default limits:

| Setting | Default |
|---|---:|
| `responseBytes` | 16 MiB |
| `sseLineBytes` | 256 KiB |
| `sseEventBytes` | 1 MiB |
| `sseBufferBytes` | 2 MiB |
| `downstreamBytes` | 16 MiB |
| `maxTrackedItems` | 4096 |
| `maxEmptyChunks` | 1024 consecutive empty chunks |

Relevant caller-supplied overrides must be positive safe integers; existing unrelated shared-limit keys are ignored. Each budget is enforced independently rather than silently increased or forced into an artificial monotonic relationship.

The framing budget covers wire framing and conservative metadata bookkeeping. Request-local identity tracking is separately bounded by both `maxTrackedItems` and `sseBufferBytes`, charging IDs/types plus per-entry bookkeeping. Retain no full payloads, partial argument history or transient delta history. These are logical resource budgets, not an exact combined process-RSS guarantee; current frame text, parsed JSON, byte buffers and bounded identity state may coexist.

Default timeouts: upstream read idle 300000 ms, downstream drain 30000 ms, policy callback 30000 ms. All are positive overrides. The integration caller supplies the request's total-lifetime/shutdown `AbortSignal`; this step does not create an independent HTTP request manager. Policy promises and pending read/drain waits are abort-aware. The reader is cancelled/released on every acquired-reader exit, including terminal success. Return immediately after the first valid known terminal frame, cancelling unread upstream data rather than waiting indefinitely for EOF.

## Relay ownership and permissions

```js
await relayNativeSse(upstream, response, {
  limits, timeouts, signal,
  beforeEmit(info, payload), // mandatory; must return/resolve exactly true
  onDiagnostic(info),     // optional, metadata-only and nonblocking
  secrets,                // optional configured secret/origin strings; never loaded here
  writer,                 // optional trusted NativeSseWriter-compatible integration object
});
```

Validate options and the mandatory policy before taking streaming ownership. A missing policy fails before acquiring the reader or sending headers. The HTTP caller handles pre-header errors and disposal of an upstream body that was never acquired by this layer.

Once invoked with valid options, the relay starts native streaming headers (unless already sent), owns stream termination and returns `{ outcome, terminal: true, emitted, bytesOut }` only after forwarding a valid known terminal/error event. Provider `failed`/`incomplete`/error outcomes remain provider data; they are not success claims or Chat finish reasons. Callers must not append a second terminal/error after the relay has taken ownership.

`beforeEmit` receives actual policy data: `{ name, known, category, featureGated }` plus the parsed native payload. It is **not a logging callback**. Registry category hints alone are insufficient authorization: shared output-item events and terminal response arrays may contain specialized tools/media. Step 3/4 policy must inspect requested features, nested output items, tool names, resources and connections against approved request scope before returning true. A test hook returning true is not a production permission implementation.

Native partial function/custom-tool arguments are emitted immediately. The client is responsible for waiting for a complete permitted call and applying approval policy. The bridge never executes generated tools or automatically approves requests.

`onDiagnostic` receives bounded sanitized event-name/category/known fields or a fixed local error code, never payloads, reasoning, IDs or tool arguments/results. Configured secret substrings and unsafe names are redacted. Diagnostic failures/rejected promises do not disrupt transport.

## Local and provider errors

After taking stream ownership, local protocol/limit/policy/timeout failures attempt at most one bounded bridge-origin notification:

```text
event: bridge.error
data: {"type":"bridge.error","error":{"code":"<fixed local code>","message":"<fixed local explanation>"}}

```

There is no Azure response ID/sequence number, no fabricated `response.failed`, no upstream payload/error text, and no `[DONE]`. The writer closes afterwards; aborted, stalled, disconnected or byte-exhausted clients are destroyed rather than reopening drain waits. Actual notification bytes are included in writer accounting.

The relay then throws safe `native_relay_failed` with a fixed `failureCode` category. The caller may record that category, but must not emit a second error or treat it as a normal completion. Unrecognized thrown values/getters map to a generic local category without serializing them.

For recognized provider error-bearing events, configured `secrets` redact matching strings of at least eight characters **only in the known error message field**. Preserve other native/opaque payloads and non-data metadata. If redaction is necessary, JSON data is reserialized; do not globally replace payload text or mutate the original policy payload. The HTTP integration caller separately owns safe upstream status/header/error-body processing and must supply the appropriate configured secrets/origin.

## Integration and verification boundary

Step 3 integrates this layer into the optional, default-off [native create route](<native-responses-api.md>) with pre-header authentication, fixed approved Azure origin/path, alias-to-deployment routing, request validation, stateless defaults and default-deny specialized feature policies. No production activation has been performed. Total lifetime, shutdown, concurrency/admission and HTTP error/header handling remain server responsibilities. No new route may forward requests before its minimum safety gates exist. Retrieval, delete, stored chaining, background cancellation and file-management endpoints are not implemented here.

The [native regression suite](<../native-sse.test.js>) uses synthetic bytes, fake downstream responses and injected readers. It covers every documented event, malformed fields, future types/extensions, framing/metadata/byte boundaries, bounded identity state, errors, policy promises, partial tool timing, cancellation/backpressure and pure imports. Lead review corrected the delegated draft before acceptance. No real Azure inference or production service restart was performed.

### Lead acceptance — Step 2

On **2026-10-22 / Windows / Node 24.20.0**, the Lead verified the final code after correcting the sub-agent draft. All **81 native tests** passed, including individual native relay cases for the exact **53-event** inventory. The complete [offline suite](<../run-offline-tests.cjs>) finished with **231 tests: 227 passed, 4 Linux-only skips, 0 failed**, exit code 0. Syntax checks for the [registry](<../native-events.js>), [transport](<../native-sse.js>) and [native tests](<../native-sse.test.js>) passed. Registry/category comparisons, documentation links and whitespace checks passed. Existing tracked production source/configuration/tests have no modifications; the native layer is isolated and the new HTTP endpoint is not enabled.
