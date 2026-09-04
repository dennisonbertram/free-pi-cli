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
import { join, resolve } from "node:path";
import { buildProviderConfig, MODEL_ID, PROVIDER_NAME, SAFE_TOOLS, type CatalogModel } from "./provider";
import { createUsageToolExtension, USAGE_TOOL_NAME } from "./usage-tool";
import { createBuyToolExtension, BUY_TOOL_NAME } from "./buy-tool";
import { createDocsToolExtension, DOCS_TOOL_NAME } from "./docs-tool";
import { createErrorNoticeExtension } from "./error-notice";
import { createToolGuardExtension } from "./tool-guard";
import { createFreePiCommandsExtension } from "./commands";
import { createHeaderExtension } from "./header";
import { resolveFreePiScope } from "./provider-lock";
import { patchResumeLine } from "./resume-line";

export interface LaunchOptions {
  baseUrl: string;
  jwt: string;
  agentDir: string;
  session?: string;
  /** Server-reported active model to display (falls back to MODEL_ID). */
  model?: string;
  /** #140: the selectable model catalog from /client-version. When present the
   * picker offers all of them; empty/absent falls back to the single `model`. */
  models?: CatalogModel[];
  /** A newer free-pi-cli version, when /client-version reported one and the
   * self-update fell back to notifying. Renders the header's update banner —
   * free-pi's replacement for pi's own (suppressed) `pi update` banner. */
  updateLatest?: string;
}

/** The models to register + scope the picker to: the server catalog when it
 * sent one, else the single active model (back-compat with a plain response). */
function catalogModelsFor(opts: LaunchOptions): CatalogModel[] {
  if (opts.models && opts.models.length > 0) return opts.models;
  const id = opts.model || MODEL_ID;
  return [{ id, name: id }];
}

// #28 R20/R20a: the exact, closed set of tool names the shipped distro ever
// legitimately runs — SAFE_TOOLS' built-ins plus the two registered custom
// tools (free_pi_usage, U5; free_pi_buy_credits, #226). Used two ways, belt
// and braces (KTD-7 found `defaultTools` alone does not block an
// extension-registered tool):
//   1. Passed as `tools` to createAgentSessionFromServices — the SDK's own
//      strict allowlist (docs/settings.md: same mechanism as the CLI's
//      `--tools` flag, "only the listed tool names are enabled").
//   2. Passed to the tool-guard extension, which blocks + reports anything
//      outside this set that still somehow reaches a tool_call event.
export const ALLOWED_TOOL_NAMES: readonly string[] = [...SAFE_TOOLS, USAGE_TOOL_NAME, BUY_TOOL_NAME, DOCS_TOOL_NAME];

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
/** KTD6: the display model name for the header — server catalog name, then
 * the active model id, then the built-in default. Exported as a test seam. */
export function resolveModelName(opts: LaunchOptions): string {
  return opts.models?.[0]?.name || opts.model || MODEL_ID;
}

export function buildRuntimeOptions(opts: LaunchOptions, sessionId: string): RuntimeBuildOptions {
  const models = catalogModelsFor(opts);
  const providerExtension: InlineExtension = {
    name: "free-pi-provider",
    factory: (pi: ExtensionAPI) => {
      pi.registerProvider(PROVIDER_NAME, buildProviderConfig(opts.baseUrl, opts.jwt, sessionId, models));
    },
  };

  // KTD7: the only channel /support has to the currently-shown banner ad's
  // click URL — set by the ads extension's onBannerAd, read by the commands
  // extension's getAdvertiserUrl. Deliberately not a shared object/class:
  // one field, one file, both extensions stay independently testable.
  let advertiserUrl: string | undefined;

  // U7: banner/inline ads + usage meter, sandboxed to UI-only hooks (KTD9).
  // See packages/pi-ads/src/sandbox.test.ts for the enforced proof.
  const adsExtension: InlineExtension = createAdsExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
    sessionId,
    onBannerAd: (u) => {
      advertiserUrl = u;
    },
  });

  // U5 (#17): read-only "what's my usage" tool. Outside packages/pi-ads on
  // purpose (KTD5) — see usage-tool.ts's header comment.
  const usageToolExtension: InlineExtension = createUsageToolExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // #226: opens the server's buy-credits page. Outside packages/pi-ads on
  // the same grounds as the usage tool (KTD5) — see buy-tool.ts's header
  // comment.
  const buyToolExtension: InlineExtension = createBuyToolExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // U2 (2026-09-03): read-only "about free-pi" docs tool. Outside
  // packages/pi-ads on the same grounds as the usage/buy tools (KTD4) —
  // see docs-tool.ts's header comment.
  const docsToolExtension: InlineExtension = createDocsToolExtension();

  // 2026-09-01: one readable, server-owned line when a turn is rejected
  // (read from turn_end's error envelope). See error-notice.ts.
  const errorNoticeExtension: InlineExtension = createErrorNoticeExtension();

  // #28 R20a: defense-in-depth block + report for any tool outside
  // ALLOWED_TOOL_NAMES that somehow reaches a tool_call event.
  const toolGuardExtension: InlineExtension = createToolGuardExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
    allowedTools: ALLOWED_TOOL_NAMES,
  });

  // 0.2.6: free-pi's slash commands — /close-other-session, /whats-new, /update.
  // A dedicated extension rather than folding into usage-tool (which stays
  // read-only).
  const commandsExtension: InlineExtension = createFreePiCommandsExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
    getAdvertiserUrl: () => advertiserUrl,
  });

  // U1/U2 (2026-09-03): free-pi's own startup header, replacing pi's
  // built-in one (hidden via quietStartup below). KTD1, KTD6.
  const headerExtension: InlineExtension = createHeaderExtension({
    modelName: resolveModelName(opts),
    updateLatest: opts.updateLatest,
  });

  // Closed, NINE-item list — SB1's structural test fails if a future edit
  // adds a tenth extension or drops one of these. Settings deliberately
  // omit `packages` (no pi-packages installed, so no MCP adapter / subagent
  // extension can be pulled in) and pin `defaultTools` to the built-in tool
  // set (never includes a subagent/background-bash/MCP tool per pi's own
  // docs — see provider.ts). Pi ships with none of those by default, so
  // there is nothing else to turn off — free-pi-cli's job is to never opt
  // back into them.
  const extensionFactories = [
    providerExtension,
    adsExtension,
    usageToolExtension,
    buyToolExtension,
    docsToolExtension,
    errorNoticeExtension,
    toolGuardExtension,
    commandsExtension,
    headerExtension,
  ];

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: PROVIDER_NAME,
    // The picker starts on the first catalog model (the server lists the
    // default first); the user switches with /model.
    defaultModel: models[0]!.id,
    defaultTools: [...SAFE_TOOLS],
    packages: [],
    // KTD1: hides pi's own startup header/skills/extensions dump so the
    // free-pi-header extension's setHeader is the only header shown (R5).
    quietStartup: true,
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
function getSessionDir(cwd: string, agentDir: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

export interface SessionManagerApi {
  create: typeof SessionManager.create;
  open: typeof SessionManager.open;
  list: typeof SessionManager.list;
}

/** Resolves the requested logical session using one explicit session directory. */
export async function createSessionManager(
  cwd: string,
  sessionDir: string,
  sessionId: string | undefined,
  api: SessionManagerApi = SessionManager,
): Promise<SessionManager> {
  if (sessionId) {
    const infos = await api.list(cwd, sessionDir);
    const info = infos.find((session) => session.id === sessionId);
    if (!info) {
      throw new Error(`No session found matching '${sessionId}' in this directory`);
    }
    return api.open(info.path, sessionDir);
  }
  return api.create(cwd, sessionDir);
}

/**
 * free-pi-cli users installed `free-pi-cli` (via npx), never `pi` directly —
 * pi's own interactive mode otherwise shows a "New version available, run
 * `pi update`" banner (checkForNewPiVersion in the SDK, gated only by this
 * env var) that names a command our users don't have. free-pi-cli already
 * has its own correctly-branded update check (update-check.ts / run.ts,
 * "run `npx free-pi-cli@latest`"), so pi's own banner is pure noise here —
 * suppress it. Does not affect pi's separate model-catalog refresh (gated by
 * PI_OFFLINE instead), which stays on.
 */
process.env.PI_SKIP_VERSION_CHECK = "1";

// Same brand-leak problem at the other end of the session: pi's exit path
// prints "To resume this session: pi --session <id>" straight to stdout and
// then exits the process. See resume-line.ts.
patchResumeLine(process.stdout);

export async function launchPi(opts: LaunchOptions): Promise<string> {
  const cwd = process.cwd();
  const sessionDir = getSessionDir(cwd, opts.agentDir);
  const sm = await createSessionManager(cwd, sessionDir, opts.session);

  // The pi logical session id is the lease key shared by the provider and ads.
  const sessionId = sm.getSessionId();
  const scopeIds = catalogModelsFor(opts).map((m) => m.id);
  const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, sessionId);

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
    // Lock the model picker to just the free-pi catalog models — pi's own
    // model-scope, no env vars touched. See provider-lock.ts.
    const scopedModels = resolveFreePiScope(services.modelRuntime, PROVIDER_NAME, scopeIds);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: [...tools],
        scopedModels,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: opts.agentDir,
    sessionManager: sm,
  });

  const mode = new InteractiveMode(runtime, {
    initialImages: [],
    initialMessages: [],
  });

  await mode.run();
  return sm.getSessionId();
}
