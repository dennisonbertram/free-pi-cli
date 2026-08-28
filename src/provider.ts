// Built via `pi.registerProvider(name, config)` per
// https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/custom-provider.md
// Types imported (type-only, erased at runtime — see note below) from the
// published package's real ProviderConfig/ProviderModelConfig
// (@earendil-works/pi-coding-agent@0.84.2, dist/core/extensions/types.d.ts).
import type { ProviderConfig } from "@earendil-works/pi-coding-agent";
import { CLI_VERSION } from "./version";

export const PROVIDER_NAME = "free-pi";
export const MODEL_ID = "deepseek/deepseek-v4-flash";

// Built-in tool names as of pi-coding-agent 0.84.2 (usage.md: "Built-in tools:
// read, bash, edit, write, grep, find, ls"). Pi ships with no subagents, no
// background bash, and no MCP by default (usage.md, "Design Principles") — the
// only way any of those would exist is if we loaded a pi-package or extension
// that adds them, which free-pi-cli deliberately never does (see pi-launch.ts).
export const SAFE_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * Pure builder for the free-pi provider config passed to `pi.registerProvider`.
 * Kept separate from pi-launch.ts so it's testable without touching the SDK.
 * The `ProviderConfig` import above is type-only, so this module (and its
 * test) never needs the pi package resolved at runtime — only for typecheck.
 */
/**
 * pi's openai-completions api is built on the openai SDK, which appends
 * `/chat/completions` to its baseURL — so the provider baseUrl must end in
 * `/v1` to reach the proxy's `/v1/chat/completions` route. Verified live
 * 2026-08-14: without this, every completion 404s.
 */
export function completionsBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

/**
 * #28 R19 (client half, KTD-3): `sessionId` is the pi logical session id
 * selected once at launch by pi-launch.ts. Threaded through as a static header
 * (ProviderConfig.headers, confirmed on the installed SDK's ProviderConfig
 * type) rather than a JWT claim: the JWT is a 90-day credential shared
 * across every process a user launches, so it cannot itself identify one
 * running process. This also finally puts the already-plumbed-but-dormant
 * x-session-id field (completions.ts already reads it for trace grouping)
 * to work for R19 enforcement too.
 */
/** A selectable model from the server catalog (/client-version `models`). `id`
 * is what the CLI sends as the request model; `name` is the picker label. */
export interface CatalogModel {
  id: string;
  name: string;
}

export function buildProviderConfig(
  baseUrl: string,
  jwt: string,
  sessionId: string,
  // #140: the catalog of selectable models (id = request model the server
  // resolves against model_catalog; name = picker label). The server forces the
  // real upstream per request, so these are display/routing ids, not upstream
  // model names.
  models: CatalogModel[],
): ProviderConfig {
  return {
    name: "free-pi",
    baseUrl: completionsBaseUrl(baseUrl),
    apiKey: jwt,
    api: "openai-completions",
    // #37: x-client-version rides alongside x-session-id on every completion
    // so the server's forced-update gate (apps/server/src/routes/completions.ts)
    // can enforce minCliVersion.
    headers: { "x-session-id": sessionId, "x-client-version": CLI_VERSION },
    models: models.map((m) => ({
      id: m.id,
      name: m.name,
      reasoning: false,
      input: ["text"] as const,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1_048_576,
      maxTokens: 8192,
    })),
  };
}
