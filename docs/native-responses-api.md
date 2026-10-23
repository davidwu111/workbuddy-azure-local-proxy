# Native Responses create API — Step 4

**Status: implemented and verified offline; disabled by default; feature use requires explicit per-alias operator policy.** The existing Chat API remains separate. No production configuration was changed, listener restarted, or real Azure request made. See [native feature permissions](<native-feature-permissions.md>) for configuration and limitations.

## Activation and routing

The optional `POST /v1/responses` endpoint exists only when `BRIDGE_NATIVE_RESPONSES=true` (factory setting `nativeResponses:true`). The default is false. Its flag is validated by [configuration](<../config.js>) and included in safe configuration identity. The [environment template](<../.env.example>) keeps it false. Enabling the flag on a running production service requires an explicit operator-approved restart; editing source alone does not change that process.

Use the same configured host/port/TLS and local `Authorization: Bearer <BRIDGE_PROXY_TOKEN>` as Chat. Only configured model aliases are accepted; omission chooses the default alias. The outbound model is the corresponding deployment, and the upstream target is fixed to the approved configured origin plus `/openai/v1/responses`, with redirects rejected. Azure credentials stay inside the bridge. Client-supplied Azure/session/identity headers are not forwarded. Native query controls are rejected instead of silently dropped.

Retrieval, delete, background cancellation, stored chaining and file-management routes are not implemented.

## Initial native request contract

Requests require bounded UTF-8 JSON and `Content-Type: application/json`. The [pure request validator](<../native-request.js>) does not translate through Chat.

- `input`: text string, typed or shorthand text messages, or fully replayed native function call/results. Preserve role, content order, optional message IDs/status and assistant `phase`; do not infer or reorder phases.
- User/system/developer blocks use `input_text`. Assistant replay can contain `input_text`, `output_text` (including existing annotations/logprobs), or the native `{type:"refusal",refusal:"..."}` block. Image/file input content requires the corresponding feature and exact approved URL/file ID or bounded inline data; arbitrary fetching is not available. See [feature policy](<native-feature-permissions.md>).
- Replayed `function_call` and `function_call_output` keep native IDs/names/argument/result strings. Each result must match an unresolved earlier call in the supplied array, call IDs must be unique, and no call may remain unresolved at the end. No remote state or global conversation history is consulted.
- `instructions`, `stream`, `max_output_tokens`, `reasoning`, `tools`, `tool_choice`, `parallel_tool_calls`, `text`, and inert `store`/`background` settings form the initial top-level allowlist. Unknown fields fail locally; recognized but deferred fields are unsupported rather than silently forwarded.
- `max_output_tokens` defaults to the minimum global/route-profile cap. Explicit positive budgets above the cap are rejected, never clamped. Nullable/unset budgets still receive the operator's finite cap.
- Native reasoning effort/mode/context are checked against the selected profile; configured global/profile defaults apply when absent. Explicit supported values and `summary:auto|concise|detailed` are preserved. A disallowed effort is rejected, not replaced.
- Functions use native `{type:"function",name,parameters?,strict?,description?}` definitions. Plain function names need no per-alias allowlist; only syntax, uniqueness and schema shape are checked. Preserve omitted/nullable native strictness and parameters instead of inserting Chat defaults. Non-null schemas must be root objects with bounded JSON and checked schema structure; explicit strict mode requires all object properties required and `additionalProperties:false`. External `$ref` targets and unsupported strict schema forms are rejected. This is not a complete Azure JSON-schema engine. Custom `{type:"custom"}` tools require the `custom-tool` grant plus an allowlisted name and supported text/Lark grammar format; calls are never executed locally.
- Named native tool choice is **`{type:"function",name:"lookup"}`**, not Chat's nested `function` object. `auto`, `none`, and `required` are supported; forced names must be declared and `required` needs tools.
- `text.format` supports `text`, `json_object`, or checked root-object `json_schema`; profile-supported verbosity is preserved.
- `store` is false unless global `allowStore`, route `nativePolicies[alias].allowStore`, and explicit request `store:true` all agree. Missing/false/null stays false; Chat storage defaults are independent. `background:true` remains blocked. Nullable stream defaults to nonstream.

Example shape (use an approved alias and your local token; this document does not authorize a live call):

```json
{
  "model": "configured-alias",
  "input": [{"role": "user", "content": "Hello"}],
  "stream": true,
  "max_output_tokens": 256,
  "store": false
}
```

Background jobs, conversation/response-ID chaining, agent references, context management, stateful endpoints, and unsupported request controls remain blocked. Hosted tools, input media, and resource IDs require exact configured per-alias permissions; see [feature policy](<native-feature-permissions.md>). Caching, sampling, metadata and other optional settings are not silently dropped.

## Native output and permissions

JSON returns the permitted Azure Responses object, preserving provider `model`, output items, annotations/logprobs, numeric usage, phases, reasoning/compaction state and opaque extensions. It does not flatten output or invent Chat choices. Foreground JSON requires a terminal status; `failed`, `incomplete` and `cancelled` remain honest provider data, while unexpected queued/in-progress JSON fails visibly.

The request-scoped output policy checks message blocks, every terminal output item, declared function names/tool choice and known specialized feature categories. It tracks distinct item IDs and call IDs in separate namespaces, with count/byte limits, without charging repeated snapshots as new calls. Argument events must refer to an observed permitted function item. Unknown future event data may remain opaque, but recognized specialized prefixes/material slots cannot bypass default-deny permissions.

All **29 specialized feature event types** remain transport schemas, not automatic permission. JSON/SSE output policy inspects nested and terminal output items and authorizes only request-declared tools/resources within operator-approved alias scope. Plain function tools need no grant. MCP calls are always-approval only; approval requests are forwarded as data and this bridge never implements auto-approval or secure approval continuation. Custom/function calls are relayed, never locally executed. Partial output is immediate and may be observed before the provider's terminal outcome. Grants are documented in [native feature permissions](<native-feature-permissions.md>).

## HTTP and stream lifecycle

The [server](<../server.js>) reuses bearer authentication, approved origin/routing, TLS, bounded uploads, concurrency/admission queues, idle/total/upload/stall timeouts, cancellation, shutdown, safe headers and no-retry behavior across Chat and native routes. Check native outbound request bytes again after routing/defaults. JSON/error/upstream/downstream/frame/identity budgets remain enforced, and configured downstream bytes override the isolated transport default.

SSE uses the [native transport contract](<native-sse-contract.md>), preserving typed payloads and SSE metadata. A recognized terminal/provider error ends the stream without Chat `[DONE]`. Before streaming ownership, errors return bounded JSON with an appropriate HTTP status. Afterwards the relay owns one `bridge.error` notification or connection destruction; the server never appends another error. Malformed/terminal-less streams do not become successful empty results.

Only known provider error message fields redact configured credentials/origin, without globally rewriting opaque native data. Logs use the existing bounded `code`, usage, byte and timing fields plus the safe native route path—never prompts, response bodies, reasoning, tool data or arbitrary source error text. Native first-token timing is a proxy material-delta emission metric, not a measured Azure TTFT or billing assertion.

## Lead verification

One `gpt-6-luna` sub-agent produced the initial draft of each stage; Lead review corrected native tool/refusal formats, HTTP error completion, output permissions/identity budgets, JSON redaction, usage capture, Code Interpreter container forms, MCP allowlists/approval handling and image-streaming gates before acceptance.

On **2026-10-23 / Windows / Node 24.20.0**, all native permission, request/policy and HTTP/TLS integration suites passed. The complete [offline runner](<../run-offline-tests.cjs>) finished with **279 tests: 275 passed, 4 Linux-only skips, 0 failed**, exit code 0. Tests use injected providers, synthetic native payloads and owned ephemeral loopback listeners, including real certificate verification and a response larger than the isolated 16 MiB transport default. Existing Chat regression tests remain passing.

These checks do not prove live Azure model/region/tool capability, installed-client support, Linux execution, quota or price. Azure feature availability is deployment/version/model/region dependent; image-generation streaming and multi-turn editing have documented support limitations. Audio request modality is not implemented; an event enum alone is not activation. Provider storage/caching/ZDR remain distinct. No production listener restart or inference occurred.
