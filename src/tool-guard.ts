// #28 R20a: defense-in-depth. free-pi-cli's closed extension list (see
// pi-launch.ts's buildRuntimeOptions) and the SDK's strict `tools` allowlist
// are the real reasons no subagent-shaped tool ever reaches the model
// (SB1). This extension is the belt to that braces: if a tool outside the
// allowed set is ever presented anyway — only reachable if a user has
// hand-placed a file in their own local extensions directory (see the
// plan's Gap Analysis; not a server-side hole) — block it rather than
// execute it, and report the occurrence. A real report is a should-never-
// fire, high-signal event, never a normal one.
import type { ExtensionAPI, InlineExtension, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

export interface CreateToolGuardOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  /** The full set of tool names this distro ever legitimately calls. */
  allowedTools: readonly string[];
  fetchImpl?: typeof fetch;
}

/** Best-effort POST /telemetry/tool-guard — never throws, never blocks the tool_call handler. */
async function reportToolGuardTrigger(opts: CreateToolGuardOptions, toolName: string): Promise<void> {
  try {
    const token = await opts.getToken();
    const doFetch = opts.fetchImpl ?? fetch;
    await doFetch(`${opts.baseUrl}/telemetry/tool-guard`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ tool_name: toolName }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // best-effort; a reporting failure must never surface to the user
  }
}

export function createToolGuardExtension(opts: CreateToolGuardOptions): InlineExtension {
  return {
    name: "free-pi-tool-guard",
    factory(pi: ExtensionAPI) {
      pi.on("tool_call", (event): ToolCallEventResult | undefined => {
        if (opts.allowedTools.includes(event.toolName)) return undefined;
        void reportToolGuardTrigger(opts, event.toolName);
        // block (not terminate): refuse the single non-allowlisted call but
        // keep the session alive. The SDK `tools` allowlist should stop any
        // such call reaching here at all, so this is belt-and-braces — and a
        // maximally-destructive terminate would hard-kill a live session on
        // the false-positive path where the SDK ever emits a legit tool under
        // an unlisted name. Blocking the one call already stops the rogue tool.
        return { block: true, reason: "tool not permitted in the free-pi distro" };
      });
    },
  };
}
