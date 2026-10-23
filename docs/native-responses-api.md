# Native Responses create API — Step 4

**Status: implemented and verified offline; disabled by default; feature use requires explicit per-alias operator policy.** The existing Chat API remains separate. No production configuration was changed and no production listener was restarted; the only real Azure requests are those of the single authorised capture run recorded in [live verification](<live-verification.md>). See [native feature permissions](<native-feature-permissions.md>) for configuration and limitations.

## Activation and routing

The optional `POST /v1/responses` endpoint exists only when `BRIDGE_NATIVE_RESPONSES=true` (factory setting `nativeResponses:true`). The default is false. Its flag is validated by [configuration](<../config.js>) and included in safe configuration identity. The [environment template](<../.env.example>) keeps it false. Enabling the flag on a running production service requires an explicit operator-approved restart; editing source alone does not change that process.

Use the same configured host/port/TLS and local `Authorization: Bearer <BRIDGE_PROXY_TOKEN>` as Chat. Only configured model aliases are accepted; omission chooses the default alias. The outbound model is the corresponding deployment, and the upstream target is fixed to the approved configured origin plus `/openai/v1/responses`, with redirects rejected. Azure credentials stay inside the bridge. Client-supplied Azure/session/identity headers are not forwarded. Native query controls are rejected instead of silently dropped.

Retrieval, delete, background cancellation, stored chaining and file-management routes are not implemented.

## Initial native request contract

Requests require bounded UTF-8 JSON and `Content-Type: application/json`. The [pure request validator](<../native-request.js>) does not translate through Chat.

- `input`: text string, typed or shorthand text messages, or fully replayed native function call/results. Preserve role, content order, optional message IDs/status and assistant `phase`; do not infer or reorder phases. Empty `input` (`[]` or `""`) is rejected locally with `invalid_parameter`; whitespace-only strings remain valid.
- User/system/developer blocks use `input_text`. Assistant replay can contain `input_text`, `output_text` (including existing annotations/logprobs), or the native `{type:"refusal",refusal:"..."}` block. Image/file input content requires the corresponding feature and exact approved URL/file ID or bounded inline data; arbitrary fetching is not available. See [feature policy](<native-feature-permissions.md>).
- Replayed `function_call` and `function_call_output` keep native IDs/names/argument/result strings. Each result must match an unresolved earlier call in the supplied array, call IDs must be unique, and no call may remain unresolved at the end. No remote state or global conversation history is consulted.

Top-level fields are enumerated below. Unknown fields fail locally; exact inert defaults (`metadata:{}`, `include:[]`, `truncation:"disabled"`, `top_logprobs:0`, `service_tier:"auto"`, `temperature:1`, `top_p:1`) are dropped instead, `parallel_tool_calls:null` and `text:{}` are omitted from the outbound payload, and every other recognized but deferred value is unsupported rather than silently forwarded. Every field added in this revision is nullable: `null` means unset and is never forwarded, except `prompt_cache_key` and `prompt_cache_options`, where an explicit `null` clears the operator default instead of inheriting it.

| Field | Rule | Forwarded |
|---|---|---|
| `model` | Configured alias; absent selects the default alias. Unknown aliases are rejected locally. | Resolved to the route deployment |
| `input` | Text string, typed or shorthand messages, or replayed native function calls/results. Empty `[]` or `""` is rejected. | Yes |
| `instructions` | Instruction-role handling governed by `BRIDGE_INSTRUCTION_POLICY`. | Yes |
| `stream` | Boolean; nullable stream defaults to nonstream. | Yes |
| `max_output_tokens` | Explicit positive client value within the ceiling; otherwise the operator's default budget. | Yes |
| `reasoning` | `effort`, `mode`, `context` and `summary` checked against the selected profile. | Yes |
| `tools` | Native function definitions and granted custom tools; syntax, uniqueness and schema shape checked. | Yes |
| `tool_choice` | `auto`, `none`, `required`, `{type:"function",name}`, or a granted `{type:"custom",name}`. | Yes |
| `parallel_tool_calls` | Boolean; applicability no-op without tools. | Yes when not `null` |
| `text` | `format` and profile-supported `verbosity`; `{}` is omitted. | Yes |
| `store` | False unless global `allowStore`, the route's `nativePolicies[alias].allowStore` and request `store:true` all agree. | Yes, as resolved false/true |
| `background` | False/null only; `true` remains blocked. | Resolved false only |
| `prompt_cache_key` | Non-secret identifier, 1-128 characters matching `[a-zA-Z0-9][a-zA-Z0-9._:-]*`. Falls back to `BRIDGE_PROMPT_CACHE_KEY` when omitted. | Yes; an explicit value overrides the configured default |
| `prompt_cache_options` | `{mode?: "implicit"\|"explicit", ttl?: "30m"}`. `mode:"explicit"` is rejected on PTU-M deployments. Falls back to `BRIDGE_PROMPT_CACHE_OPTIONS`. | Yes |
| `prompt_cache_retention` | `"in_memory"` or `"24h"`. | Yes |
| `temperature` | Validated against the route profile's `samplingEfforts` at the effective reasoning effort. An exact `1` is the documented default and is dropped before that check, so it never fails. | Yes when non-default and the profile allows sampling at that effort |
| `top_p` | Validated against the route profile's `samplingEfforts` at the effective reasoning effort. An exact `1` is the documented default and is dropped before that check, so it never fails. | Yes when non-default and the profile allows sampling at that effort |
| `include` | At most 16 unique values from `reasoning.encrypted_content`, `message.output_text.logprobs`, `file_search_call.results`, `code_interpreter_call.outputs`, `image_generation_call.result`, `web_search_call.action.sources`. A tool-scoped value requires that tool to be declared on the same request. Unknown values are `unsupported_parameter`. | Yes |
| `top_logprobs` | Integer 1-20; requires `include` to contain `message.output_text.logprobs`. An exact `0` is the default and is dropped. | Yes |
| `metadata` | At most 16 entries, keys up to 64 characters, string values up to 512 characters; forwarded verbatim. | Yes |
| `safety_identifier` | Up to 128 characters. | Yes |
| `user` | Up to 512 characters. | Yes |
| `max_tool_calls` | Integer 1-1000. | Yes |
| `service_tier` | One of `default`, `flex`, `scale`, `priority`, `fast`; `auto` is the default and is dropped. | Yes when not `auto` |
| `truncation` | `auto` only; `disabled` is the default and is dropped. | Yes for `auto` |

- `max_output_tokens` precedence is the explicit positive client value, which is rejected rather than clamped if above the ceiling; otherwise `BRIDGE_DEFAULT_MAX_OUTPUT_TOKENS` applies, itself capped by the minimum of the global and route-profile caps. Nullable/unset budgets still receive the operator's finite budget, and the default never raises a route's profile cap.
- Native instruction handling follows `BRIDGE_INSTRUCTION_POLICY` with the same semantics as the Chat route: `reject-mixed` (startup default) fails on a system+developer mix, `developer`/`system` rewrite the instruction role, and `preserve` keeps both.
- Native reasoning effort/mode/context are checked against the selected profile; configured global/profile defaults apply when absent. Explicit supported values and `summary:auto|concise|detailed` are preserved. A disallowed effort is rejected, not replaced.
- Functions use native `{type:"function",name,parameters?,strict?,description?}` definitions. Plain function names need no per-alias allowlist; only syntax, uniqueness and schema shape are checked. Preserve omitted/nullable native strictness and parameters instead of inserting Chat defaults. Non-null schemas must be root objects with bounded JSON and checked schema structure; explicit strict mode requires all object properties required and `additionalProperties:false`. External `$ref` targets and unsupported strict schema forms are rejected. This is not a complete Azure JSON-schema engine. Custom `{type:"custom"}` tools require the `custom-tool` grant plus an allowlisted name and supported text/Lark grammar format; calls are never executed locally.
- Named native tool choice is **`{type:"function",name:"lookup"}`**, not Chat's nested `function` object. `auto`, `none`, and `required` are supported; forced names must be declared and `required` needs tools.
- `text.format` supports `text`, `json_object`, or checked root-object `json_schema`; profile-supported verbosity is preserved.
- `store` is false unless global `allowStore`, route `nativePolicies[alias].allowStore`, and explicit request `store:true` all agree. Missing/false/null stays false; Chat storage defaults are independent. `background:true` remains blocked. Nullable stream defaults to nonstream.
- `include:["reasoning.encrypted_content"]` makes the provider return reasoning items carrying `encrypted_content`. The bridge relays those items unchanged; it never parses, logs or persists them. `reasoning_text` deltas remain suppressed on the Chat route.
- `prompt_cache_breakpoint` on an `input_text` content part accepts only `{mode:"explicit"}`; it requires the route profile to enable `cacheBreakpoints` and is rejected on PTU-M.
- `prompt` stays deferred: it selects a provider-side prompt template, which is a resource identity like a file or vector-store ID and therefore needs its own grant.

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

Background jobs, conversation/response-ID chaining, agent references, context management, stateful endpoints, and unsupported request controls remain blocked. Hosted tools, input media, and resource IDs require exact configured per-alias permissions; see [feature policy](<native-feature-permissions.md>). Caching, sampling, metadata and other optional settings are not silently dropped unless they take an exact inert default listed above.

## Native output and permissions

JSON returns the permitted Azure Responses object, preserving provider `model`, output items, annotations/logprobs, numeric usage, phases, reasoning/compaction state and opaque extensions. It does not flatten output or invent Chat choices. Foreground JSON requires a terminal status; `failed`, `incomplete` and `cancelled` remain honest provider data, while unexpected queued/in-progress JSON fails visibly.

The request-scoped output policy checks message blocks, every terminal output item, declared function names/tool choice and known specialized feature categories. It tracks distinct item IDs and call IDs in separate namespaces, with count/byte limits, without charging repeated snapshots as new calls. Argument events must refer to an observed permitted function item. Unknown future event data may remain opaque, but recognized specialized prefixes/material slots cannot bypass default-deny permissions.

All **29 specialized feature event types** remain transport schemas, not automatic permission. JSON/SSE output policy inspects nested and terminal output items and authorizes only request-declared tools/resources within operator-approved alias scope. Plain function tools need no grant. MCP calls are always-approval only; approval requests are forwarded as data and this bridge never implements auto-approval or secure approval continuation. Custom/function calls are relayed, never locally executed. Partial output is immediate and may be observed before the provider's terminal outcome. Grants are documented in [native feature permissions](<native-feature-permissions.md>). Azure also requires an `x-ms-oai-image-generation-deployment` header that this bridge does not set, so an `image-generation` grant does not by itself make the feature work against Azure.

- Provider collections documented as nullable (`reasoning.summary`, `reasoning.content`, `output_text.annotations`, `output_text.logprobs`) are accepted as an explicit `null`, because a null is equivalent to omission there, while `message.content` must still be an array and a non-null wrong-typed collection is still rejected.
- `response.function_call_arguments.done` carries `arguments` but not `name`; the name belongs to the function-call item. `name` is therefore accepted only as an optional string when a provider sends it, and its absence is not an error. Observed once on 2026-10-23 with `gpt-6-luna` PAYG: before that change the relay ended the stream with `bridge.error` / `invalid_native_shape` after `response.function_call_arguments.delta`.
- Reasoning items may arrive with `content: []` and `encrypted_content` present even though `include:["reasoning.encrypted_content"]` was not requested; the captured item also carried an empty `summary` array rather than an item-level `null`. The bridge relays all of these forms unchanged: it does not require the include before accepting `encrypted_content`, and it never parses, logs or persists it.
- `response.output_text.delta` and `response.function_call_arguments.delta` may carry an `obfuscation` field; it is relayed untouched.

## HTTP and stream lifecycle

The [server](<../server.js>) reuses bearer authentication, approved origin/routing, TLS, bounded uploads, concurrency/admission queues, idle/total/upload/stall timeouts, cancellation, shutdown, safe headers and no-retry behavior across Chat and native routes. Check native outbound request bytes again after routing/defaults. JSON/error/upstream/downstream/frame/identity budgets remain enforced, and configured downstream bytes override the isolated transport default.

SSE uses the [native transport contract](<native-sse-contract.md>), preserving typed payloads and SSE metadata. A recognized terminal/provider error ends the stream without Chat `[DONE]`. Before streaming ownership, errors return bounded JSON with an appropriate HTTP status. Afterwards the relay owns one `bridge.error` notification or connection destruction; the server never appends another error. Malformed/terminal-less streams do not become successful empty results.

Only known provider error message fields redact configured credentials/origin, without globally rewriting opaque native data. Logs use the existing bounded `code`, usage, byte and timing fields plus the safe native route path—never prompts, response bodies, reasoning, tool data or arbitrary source error text. Native first-token timing is a proxy material-delta emission metric, not a measured Azure TTFT or billing assertion.

## Lead verification

One `gpt-6-luna` sub-agent produced the initial draft of each stage; Lead review corrected native tool/refusal formats, HTTP error completion, output permissions/identity budgets, JSON redaction, usage capture, Code Interpreter container forms, MCP allowlists/approval handling and image-streaming gates before acceptance.

On **2026-10-23 / Windows / Node 24.20.0**, all native permission, request/policy and HTTP/TLS integration suites passed. The complete [offline runner](<../run-offline-tests.cjs>) finished with **279 tests: 275 passed, 4 Linux-only skips, 0 failed**, exit code 0. Tests use injected providers, synthetic native payloads and owned ephemeral loopback listeners, including real certificate verification and a response larger than the isolated 16 MiB transport default. Existing Chat regression tests remain passing.

These checks do not prove live Azure model/region/tool capability, installed-client support, Linux execution, quota or price. Azure feature availability is deployment/version/model/region dependent; image-generation streaming and multi-turn editing have documented support limitations. Audio request modality is not implemented; an event enum alone is not activation. Provider storage/caching/ZDR remain distinct. No production listener restart or inference occurred during these offline checks.
