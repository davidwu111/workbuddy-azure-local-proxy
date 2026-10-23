# Native Responses feature permissions (Step 4)

Native create remains separately disabled unless `BRIDGE_NATIVE_RESPONSES=true`. All native features/resources and storage remain denied unless each relevant route alias receives an operator policy. Chat routing/defaults are unchanged. The bridge validates request schemas and request-scoped JSON/SSE output policy; permission is not evidence that a deployment/model/region can execute a feature.

## Configuration

`BRIDGE_NATIVE_POLICIES` is JSON object keyed only by configured outward model aliases. Missing aliases normalize to deny-all. Unknown aliases/keys, duplicates, invalid types, unsafe URLs, caller/server secret fields and unknown capabilities fail startup. The normalized policy is immutable/null-prototype. Profile keys:

```json
{
  "alias": {
    "features": ["web-search", "custom-tool"],
    "allowStore": false,
    "vectorStoreIds": [], "fileIds": [], "containerIds": [],
    "customToolNames": ["lookup"],
    "mediaUrls": [], "imageModels": [], "mcpServers": [],
    "verifiedCapabilities": []
  }
}
```

Lists are unique and bounded; resource identifiers are exact, operator-approved opaque IDs. `containerIds:["auto"]` explicitly allows Azure auto containers for Code Interpreter. Every `mcpServers` entry must list at least one permitted tool. URLs are exact HTTPS targets with no credentials, query/fragment secrets, local/private hostnames/IPs or nonstandard ports; bridge does not fetch these URLs. Use only public, no-auth MCP URLs. MCP headers, credentials and authenticated connectors are unsupported. This URL validation is a conservative syntax guard, not DNS pinning or a general SSRF defense for downstream Azure fetching. Plain `type:"function"` tools are **not** a gated feature: they stay in the initial contract and are only relayed.

Supported feature identifiers: `custom-tool`, `web-search`, `file-search`, `code-interpreter`, `image-generation`, `mcp`, `image-input`, and `file-input`. No audio request modality is implemented, so no audio grant exists and audio-prefixed events are always denied. `verifiedCapabilities` recognizes only `image-generation-streaming`, an explicit operator assertion rather than Azure live verification. Image generation streaming additionally requires `image-generation` plus `image-generation-streaming`, as does any `partial_images` request; Azure documents image generation streaming/multi-turn editing as currently unsupported, so do not enable it without deployment-specific verification.

## Request formats and limits

- Plain functions (`type:function`) need no grant and preserve nullable `strict`/`parameters`. Custom tools (`type:custom`) require `custom-tool` plus a configured name; text or Lark grammar formats are supported. Calls are relayed only, never executed in the bridge.
- Web search supports `web_search_preview` and `web_search`, bounded `search_context_size` and `user_location` approximate fields. Unsupported options reject rather than disappear.
- File search requires explicit approved `vector_store_ids`; unsupported filters are rejected. Returned `results` are optional, and any returned file/vector identity must be approved.
- Code Interpreter takes the documented `container` form: an approved container ID string, or `{type:"auto"}` when `containerIds` includes `auto`. Approved input file IDs apply to either form.
- Image generation requires an explicit `model` that appears in the profile's `imageModels`, so a request cannot fall back to an unapproved provider default. Streaming or `partial_images` requires the verified capability described above.
- MCP requires the exact configured server label/URL **and** an `allowed_tools` list; omitting the list is rejected rather than granting every tool on that server. `require_approval` is forced to `always` and caller `never` is rejected. Approval requests are preserved to the caller as data and never auto-approved; `mcp_approval_response` replay is deferred because this stateless bridge cannot securely correlate a human approval. The bridge never executes or approves a call itself.
- Image/file inputs support bounded base64 data where documented, configured file IDs, or exact URLs in `mediaUrls`. Inline image data is limited to 2 MiB encoded. Arbitrary remote URLs and local fetching are denied.

Each group must appear both in the operator profile and in the current request as an actual validated declaration/input. Tools declared but not permitted are rejected. Output is narrowed to the **request**, not only the profile: returned vector stores, containers, MCP tool names and image models must also be declared by this request. Output-item and content-part events and every terminal `response.output` item are inspected in JSON and SSE. Annotations are restricted to `url_citation` (plain HTTP(S) URL without credentials) or `file_citation` with an approved file ID; other annotation shapes are denied because they can carry unapproved container/file identities. Hosted call identity/resource fields are correlated against declared tools and approved IDs; unsupported or ambiguous specialized output fails closed. Native function/custom calls use distinct item/call IDs and request-local byte/count budgets; partial arguments are forwarded immediately after observed-item correlation, never executed.

## Storage and deferred state

`store` is false unless global `BRIDGE_ALLOW_STORE=true`, route `allowStore=true`, and this request explicitly sends `store:true`. Missing/false/null remain false. This does not modify Chat `defaults.store`. `background:true`, prior-response/conversation/agent references, retrieve/delete/cancel/file-management routes, response stores and chaining remain blocked. Provider persistence, cache behavior and zero-data-retention are separate service controls; this switch is not a ZDR guarantee.

## Schema/capability boundary

Schemas follow the Azure Responses REST reference and Azure Responses how-to, not OpenAI-only or AgentServer SDK schemas. Deployment, model, API version and region support vary. Feature permission does not assert actual live capability. No inference or activation was performed for this change.

## Verification

On **2026-10-23 / Windows / Node 24.20.0**, the permission, request/policy and native HTTP suites passed, and the complete [offline runner](<../run-offline-tests.cjs>) finished with **281 tests: 277 passed, 4 Linux-only skips, 0 failed**. A `gpt-6-luna` draft, Lead correction, and an independent read-only `deepseek-flash` audit preceded acceptance. Review fixes: plain functions need no grant; Code Interpreter accepts the documented string/`auto` container forms; file-search results are optional; MCP requires an explicit tool allowlist; approval requests are preserved instead of denied; image generation requires an approved model; granted hosted-feature events now stream instead of failing closed; annotations and returned resources are narrowed to the request; URL policy rejects all IP-literal hosts. These checks use synthetic payloads and injected providers only; they do not prove live Azure model, region, tool, quota or pricing behaviour.

References: [Azure Responses REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses), [Azure Responses how-to](https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/responses). The endpoint and SSE mechanics remain described in [native Responses API](<native-responses-api.md>) and [native SSE contract](<native-sse-contract.md>).