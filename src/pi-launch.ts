import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  InteractiveMode,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { createAdsExtension } from "@freepi/pi-ads";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderConfig, MODEL_ID, PROVIDER_NAME, SAFE_TOOLS, type CatalogModel } from "./provider";
import { createUsageToolExtension, USAGE_TOOL_NAME } from "./usage-tool";
import { createImageToolExtension, IMAGE_TOOL_NAME } from "./image-tool";
import { createWebToolsExtension, DOCS_LOOKUP_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "./web-tools";
import { createBuyToolExtension, BUY_TOOL_NAME } from "./buy-tool";
import { createDocsToolExtension, DOCS_TOOL_NAME } from "./docs-tool";
import { createTodoToolExtension, TODO_TOOL_NAME } from "./todo-tool";
import { createToolAliasesExtension } from "./tool-aliases";
import { createErrorNoticeExtension } from "./error-notice";
import { AGENT_RULES } from "./agent-rules";
import { createToolGuardExtension } from "./tool-guard";
import { installBugHandler } from "./bug-report";
import { installFooterRightAlign } from "./footer-align";
import { createFreePiCommandsExtension } from "./commands";
import { createHeaderExtension } from "./header";
import { resolveFreePiScope } from "./provider-lock";
import { createFusionExtension, resolveFusionIds } from "./fusion";
import { patchResumeLine } from "./resume-line";
import { decideProjectTrustInteractive, projectTrustForCwd } from "./project-trust";

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
  /** Server-chosen Fusion planner/executor ids (from /client-version). */
  fusion?: { planner: string; executor: string };
  /** A newer free-pi-cli version, when /client-version reported one and the
   * self-update fell back to notifying. Renders the header's update banner —
   * free-pi's replacement for pi's own (suppressed) `pi update` banner. */
  updateLatest?: string;
  /** Base64url Gravity context for the ads extension's /ads/next header; undefined when the pixel is off or not ready. */
  getGravityContext?: () => string | undefined;
  /**
   * Whether the current folder's project resources (.pi/mcp.json, .pi/extensions,
   * .pi/settings.json, .agents/skills) may load. launchPi() decides this before
   * the TUI starts (project-trust.ts). Absent means untrusted: pi's SettingsManager
   * would otherwise default to trusted.
   */
  projectTrusted?: boolean;
}

/** The models to register + scope the picker to: the server catalog when it
 * sent one, else the single active model (back-compat with a plain response). */
function catalogModelsFor(opts: LaunchOptions): CatalogModel[] {
  if (opts.models && opts.models.length > 0) return opts.models;
  const id = opts.model || MODEL_ID;
  return [{ id, name: id }];
}

// #28 R20/R20a: the exact, closed set of tool names the shipped distro ever
// legitimately runs — SAFE_TOOLS' built-ins, the registered custom tools
// (free_pi_usage, U5; free_pi_buy_credits, #226; free_pi_docs; todo), and
// pi's `codemode` and `tool_search` (2026-10-13, user-added MCP servers). MCP
// tools themselves (`mcp__<server>__<tool>` and the three MCP resource tools)
// are not listed: the user picks those servers, and tool-guard.ts admits them
// by name shape. Used two ways, belt
// and braces (KTD-7 found `defaultTools` alone does not block an
// extension-registered tool):
//   1. Passed as `tools` to createAgentSessionFromServices — the SDK's own
//      strict allowlist (docs/settings.md: same mechanism as the CLI's
//      `--tools` flag, "only the listed tool names are enabled").
//   2. Passed to the tool-guard extension, which blocks + reports anything
//      outside this set that still somehow reaches a tool_call event.
export const ALLOWED_TOOL_NAMES: readonly string[] = [
  ...SAFE_TOOLS,
  USAGE_TOOL_NAME,
  BUY_TOOL_NAME,
  DOCS_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  DOCS_LOOKUP_TOOL_NAME,
  IMAGE_TOOL_NAME,
  TODO_TOOL_NAME,
  "codemode",
  "tool_search",
];

/**
 * The SDK `tools` list: ALLOWED_TOOL_NAMES plus the MCP tool patterns. pi never
 * declares an MCP tool that no entry names or matches, so without these a
 * user server with `"exposure": "direct"` (or a direct `toolExposure`) would
 * have no tools declared. Servers on the default codemode exposure stay
 * undeclared either way. The guard still admits the same names (tool-guard.ts).
 */
export const SDK_TOOLS: readonly string[] = [
  ...ALLOWED_TOOL_NAMES,
  "mcp__*",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/** Bundled skills. From src/ or from the built dist/ the folder is one level up. */
export const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");

export interface RuntimeBuildOptions {
  settingsManager: SettingsManager;
  resourceLoaderOptions: {
    extensionFactories: InlineExtension[];
    additionalSkillPaths: string[];
    appendSystemPromptOverride: (base: string[]) => string[];
  };
  /** Names of every extension this distro will load — the property SB1's structural test asserts on. */
  extensionNames: string[];
  tools: readonly string[];
}

/**
 * Pure construction of the pi runtime free-pi-cli ships: which extensions
 * load, which tools are enabled, and the settings pinning `packages: []`
 * (no pi-package registry, so no subagent package can be pulled in). Extracted from launchPi() as a test seam (#28 SB1) —
 * launchPi() itself drives the real interactive TUI and is only exercised
 * when the bin actually runs, never in `bun test`.
 */
/** KTD6: the display model name for the header — server catalog name, then
 * the active model id, then the built-in default. Exported as a test seam. */
export function resolveModelName(opts: LaunchOptions): string {
  return opts.models?.[0]?.name || opts.model || MODEL_ID;
}

/**
 * The in-memory settings, with trust for one folder. `projectTrusted` gates
 * every project resource pi would load from that folder (.pi/mcp.json,
 * .pi/extensions, .pi/settings.json, skills); pi defaults it to true, so it is
 * always passed explicitly.
 */
export function buildSettingsManager(opts: LaunchOptions, models: CatalogModel[], projectTrusted: boolean): SettingsManager {
  return SettingsManager.inMemory(
    {
      defaultProvider: PROVIDER_NAME,
      // The picker starts on the first catalog model (the server lists the
      // default first); the user switches with /model.
      defaultModel: models[0]!.id,
      defaultTools: [...SAFE_TOOLS, TODO_TOOL_NAME],
      packages: [],
      // KTD1: hides pi's own startup header/skills/extensions dump so the
      // free-pi-header extension's setHeader is the only header shown (R5).
      quietStartup: true,
      // pi 1.2.0 defaults to fullscreen; keep 0.84's inline rendering with normal scrollback.
      tuiMode: "regular",
      // pi 1.2.0 falls back to a "system" palette; keep 0.84's light/dark pick from the terminal background.
      theme: "light/dark",
      // Pi's own install ping to pi.dev/api/report-install (interactive-mode.js)
      // is off for free-pi users; PI_TELEMETRY=0 below enforces it too.
      enableInstallTelemetry: false,
    },
    { projectTrusted },
  );
}

/** Settings for one runtime: pi calls the runtime factory per folder (resume, new, fork, tree). */
export function settingsForRuntime(
  opts: LaunchOptions,
  rtCwd: string,
  launch: { cwd: string; trusted: boolean },
): SettingsManager {
  return buildSettingsManager(opts, catalogModelsFor(opts), projectTrustForCwd(rtCwd, launch, opts.agentDir));
}

export function buildRuntimeOptions(opts: LaunchOptions, sessionId: string): RuntimeBuildOptions {
  // pi's MCP extension finds mcp.json, mcp-auth.json and mcp.log through
  // getAgentDir(), which reads this env var and otherwise falls back to the
  // user's own ~/.pi/agent. Point it at free-pi's agent dir so user servers
  // live in ~/.free-pi/agent/mcp.json and a real pi install is never read.
  process.env.PI_CODING_AGENT_DIR = opts.agentDir;
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
    getGravityContext: opts.getGravityContext,
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

  // web_search + docs_lookup: server-executed, metered against the daily allowance.
  const webToolsExtension: InlineExtension = createWebToolsExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // generate_image: server-generated, saved under <cwd>/images/, metered like web tools.
  const imageToolExtension: InlineExtension = createImageToolExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

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

  // 2026-10-13: a task list for the model, and pi's own MCP support so users
  // can add their own MCP servers (`free-pi-cli mcp add`, ~/.free-pi/agent/mcp.json).
  // The pi factories are bare functions with no name, so wrap them to keep
  // extensionNames stable. free-pi bundles no MCP servers. Codemode runs with
  // `models: false`: scripts get no `models` global, so a script can never
  // start a model request of its own (one agent per user, SB2).
  const todoToolExtension: InlineExtension = createTodoToolExtension();
  const toolAliasesExtension: InlineExtension = createToolAliasesExtension();
  const mcpExtension: InlineExtension = { name: "pi-mcp", factory: createMcpExtension() };
  const codemodeExtension: InlineExtension = { name: "pi-codemode", factory: createCodemodeExtension({ models: false }) };
  const toolSearchExtension: InlineExtension = { name: "pi-tool-search", factory: createToolSearchExtension() };

  // Closed, SEVENTEEN-item list — SB1's structural test fails if a future edit
  // adds or drops one. Settings deliberately omit pi packages (`packages: []`,
  // so no subagent extension or registry MCP adapter can be pulled in) and
  // pin `defaultTools` to the built-in tool set plus `todo`. The only MCP
  // servers that load are the ones the user put in mcp.json; the MCP
  // extension turns `codemode` on when one connects, and the model reaches
  // MCP tools through codemode scripts (every call still passes the guard).
  const extensionFactories = [
    providerExtension,
    createFusionExtension(models[0]!.id, resolveFusionIds(models.map((m) => m.id), opts.fusion)),
    adsExtension,
    usageToolExtension,
    buyToolExtension,
    docsToolExtension,
    webToolsExtension,
    imageToolExtension,
    errorNoticeExtension,
    toolGuardExtension,
    commandsExtension,
    headerExtension,
    todoToolExtension,
    toolAliasesExtension,
    mcpExtension,
    codemodeExtension,
    toolSearchExtension,
  ];

  const settingsManager = buildSettingsManager(opts, models, opts.projectTrusted === true);

  return {
    settingsManager,
    // The override form, not appendSystemPrompt: that one turns off pi's
    // discovery of the user's own APPEND_SYSTEM.md.
    resourceLoaderOptions: {
      extensionFactories,
      additionalSkillPaths: [SKILLS_DIR],
      appendSystemPromptOverride: (base) => [...base, AGENT_RULES],
    },
    extensionNames: extensionFactories.map((e) => (e as { name: string }).name),
    tools: SDK_TOOLS,
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

// Pi reads PI_TELEMETRY ahead of the enableInstallTelemetry setting (core/telemetry.js).
process.env.PI_TELEMETRY = "0";

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
  const projectTrusted = await decideProjectTrustInteractive(cwd, opts.agentDir);
  const { resourceLoaderOptions, tools } = buildRuntimeOptions({ ...opts, projectTrusted }, sessionId);
  const launchTrust = { cwd, trusted: projectTrusted };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: rtCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: rtCwd,
      agentDir: opts.agentDir,
      // Trust is per folder: /resume may switch to a session from another one.
      settingsManager: settingsForRuntime(opts, rtCwd, launchTrust),
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
  installBugHandler(mode, { baseUrl: opts.baseUrl, getToken: () => opts.jwt });
  installFooterRightAlign(mode);

  await mode.run();
  return sm.getSessionId();
}
