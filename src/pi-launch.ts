import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  InteractiveMode,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createAdsExtension } from "@freepi/pi-ads";
import { buildProviderConfig, MODEL_ID, PROVIDER_NAME, SAFE_TOOLS } from "./provider";
import { createUsageToolExtension, USAGE_TOOL_NAME } from "./usage-tool";
import { createToolGuardExtension } from "./tool-guard";

export interface LaunchOptions {
  baseUrl: string;
  jwt: string;
  agentDir: string;
}

// #28 R20/R20a: the exact, closed set of tool names the shipped distro ever
// legitimately runs — SAFE_TOOLS' built-ins plus the one registered custom
// tool (free_pi_usage, U5). Used two ways, belt and braces (KTD-7 found
// `defaultTools` alone does not block an extension-registered tool):
//   1. Passed as `tools` to createAgentSessionFromServices — the SDK's own
//      strict allowlist (docs/settings.md: same mechanism as the CLI's
//      `--tools` flag, "only the listed tool names are enabled").
//   2. Passed to the tool-guard extension, which blocks + reports anything
//      outside this set that still somehow reaches a tool_call event.
export const ALLOWED_TOOL_NAMES: readonly string[] = [...SAFE_TOOLS, USAGE_TOOL_NAME];

export interface RuntimeBuildOptions {
  settingsManager: SettingsManager;
  resourceLoaderOptions: { extensionFactories: InlineExtension[] };
  /** Names of every extension this distro will load — the property SB1's structural test asserts on. */
  extensionNames: string[];
  tools: readonly string[];
}

/**
 * Pure construction of the pi runtime free-pi-cli ships: which extensions
 * load, which tools are enabled, and the settings pinning `packages: []`
 * (no pi-package registry, so no MCP adapter or subagent package can be
 * pulled in). Extracted from launchPi() as a test seam (#28 SB1) —
 * launchPi() itself drives the real interactive TUI and is only exercised
 * when the bin actually runs, never in `bun test`.
 */
export function buildRuntimeOptions(opts: LaunchOptions, sessionId: string): RuntimeBuildOptions {
  const providerExtension: InlineExtension = {
    name: "free-pi-provider",
    factory: (pi: ExtensionAPI) => {
      pi.registerProvider(PROVIDER_NAME, buildProviderConfig(opts.baseUrl, opts.jwt, sessionId));
    },
  };

  // U7: banner/inline ads + usage meter, sandboxed to UI-only hooks (KTD9).
  // See packages/pi-ads/src/sandbox.test.ts for the enforced proof.
  const adsExtension: InlineExtension = createAdsExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // U5 (#17): read-only "what's my usage" tool. Outside packages/pi-ads on
  // purpose (KTD5) — see usage-tool.ts's header comment.
  const usageToolExtension: InlineExtension = createUsageToolExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // #28 R20a: defense-in-depth block + report for any tool outside
  // ALLOWED_TOOL_NAMES that somehow reaches a tool_call event.
  const toolGuardExtension: InlineExtension = createToolGuardExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
    allowedTools: ALLOWED_TOOL_NAMES,
  });

  // Closed, four-item list — SB1's structural test fails if a future edit
  // adds a fifth extension or drops one of these. Settings deliberately omit
  // `packages` (no pi-packages installed, so no MCP adapter / subagent
  // extension can be pulled in) and pin `defaultTools` to the built-in tool
  // set (never includes a subagent/background-bash/MCP tool per pi's own
  // docs — see provider.ts). Pi ships with none of those by default, so
  // there is nothing else to turn off — free-pi-cli's job is to never opt
  // back into them.
  const extensionFactories = [providerExtension, adsExtension, usageToolExtension, toolGuardExtension];

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: PROVIDER_NAME,
    defaultModel: MODEL_ID,
    defaultTools: [...SAFE_TOOLS],
    packages: [],
  });

  return {
    settingsManager,
    resourceLoaderOptions: { extensionFactories },
    extensionNames: extensionFactories.map((e) => (e as { name: string }).name),
    tools: ALLOWED_TOOL_NAMES,
  };
}

/**
 * Launch the real pi TUI wired to the free-pi provider. This is the seam
 * `run.ts` calls through `RunDeps.launchPi` so tests can stub it out — the
 * real pi SDK integration below is exercised only when the bin is actually
 * run, never in `bun test` (starting the real TUI needs a real terminal).
 */
export async function launchPi(opts: LaunchOptions): Promise<void> {
  // #28 R19 (KTD-3): one stable id for the lifetime of this OS process,
  // threaded to the server as x-session-id (provider.ts) on every
  // completion so the server can tell "one session, many turns" apart from
  // "a second session on the same JWT."
  const sessionId = crypto.randomUUID();
  const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, sessionId);

  const cwd = process.cwd();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: rtCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: rtCwd,
      agentDir: opts.agentDir,
      settingsManager,
      resourceLoaderOptions,
    });
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: [...tools],
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: opts.agentDir,
    sessionManager: SessionManager.create(cwd),
  });

  const mode = new InteractiveMode(runtime, {
    initialImages: [],
    initialMessages: [],
  });

  await mode.run();
}
