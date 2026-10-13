// 0.3.0: /bug sends a text-only report to the free-pi server (POST /bug-reports)
// instead of pi's built-in /bug (which uploads to the pi developers). Pi cannot
// disable or override a built-in, so pi-launch.ts replaces its handler method.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BugReportResponseSchema, type BugReportRequest } from "@freepi/shared";
import { CLI_VERSION } from "./version";

export const BUG_USAGE = "Usage: /bug <what went wrong>";
export const BUG_DESCRIPTION = "Report a bug to free-pi";

export type BugCommand = { kind: "none" } | { kind: "usage" } | { kind: "report"; description: string };

/** Parses the editor text. Only "/bug" alone or "/bug<whitespace>..." is the command ("/bugs" is not). */
export function parseBugCommand(text: string): BugCommand {
  const t = text.trim();
  if (!/^\/bug(\s|$)/.test(t)) return { kind: "none" };
  const description = t.slice("/bug".length).trim();
  return description ? { kind: "report", description } : { kind: "usage" };
}

export function buildBugRequest(
  description: string,
  ctx: { sessionId?: string; model?: string },
): BugReportRequest {
  return { description, session_id: ctx.sessionId, cli_version: CLI_VERSION, model: ctx.model };
}

export type BugResult = { ok: true; id: string } | { ok: false; message: string };

export function mapBugFailure(status: number): string {
  if (status === 401) return "Couldn't send the bug report: you're signed out. Restart free-pi-cli to sign in again.";
  if (status === 429) return "Couldn't send the bug report: you've reached today's limit of 20 reports. Try again tomorrow.";
  if (status === 413) return "Couldn't send the bug report: it is too large.";
  if (status === 400) return "Couldn't send the bug report: the description is too long (4000 characters max).";
  return `Couldn't send the bug report (the server returned ${status}). Try again in a moment.`;
}

export interface SendBugOptions {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}

/** Never throws. */
export async function sendBugReport(opts: SendBugOptions, body: BugReportRequest): Promise<BugResult> {
  try {
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}/bug-reports`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await opts.getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return { ok: false, message: mapBugFailure(res.status) };
    const parsed = BugReportResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { ok: false, message: mapBugFailure(res.status) };
    return { ok: true, id: parsed.data.id };
  } catch {
    return { ok: false, message: "Couldn't reach free-pi to send the bug report — check your connection." };
  }
}

/** The slice of pi's InteractiveMode that the /bug handler touches. */
export interface BugMode {
  session: { sessionId?: string; model?: { id: string } };
  editor: { getText(): string; setText(t: string): void };
  showStatus(message: string): void;
  showError(message: string): void;
}

/** The text of the editor line pi's `/bug` dispatch cleared before calling the handler. */
export function makeBugHandler(mode: BugMode, opts: SendBugOptions) {
  return async (hint?: string): Promise<void> => {
    if (!hint) return mode.showStatus(BUG_USAGE);
    const r = await sendBugReport(
      opts,
      buildBugRequest(hint, { sessionId: mode.session.sessionId, model: mode.session.model?.id }),
    );
    if (r.ok) return mode.showStatus(`Thanks — bug report received (#${r.id}).`);
    if (!mode.editor.getText()) mode.editor.setText(`/bug ${hint}`);
    mode.showError(r.message);
  };
}

/**
 * Pi 1.2.0 runs its built-in /bug (an upload to the pi developers) for every
 * idle submit path (Enter, autocomplete-then-Enter, Alt+Enter) through
 * InteractiveMode.handleBugCommand, so replacing that one method on our own
 * instance reroutes all of them. (While the agent is streaming, pi queues
 * "/bug x" as model text for every built-in; that uploads nothing, so we leave it.)
 * bug-report.test.ts fails if a pi upgrade removes the method.
 */
export function installBugHandler(mode: object, opts: SendBugOptions): void {
  (mode as { handleBugCommand: unknown }).handleBugCommand = makeBugHandler(mode as BugMode, opts);
}

/** Autocomplete: keep /bug listed, with a free-pi description. */
export function registerBugAutocomplete(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.addAutocompleteProvider((cur) => ({
      // Explicit delegation: the current provider is a class instance, so spreading it would drop its prototype methods.
      triggerCharacters: cur.triggerCharacters,
      applyCompletion: (...a) => cur.applyCompletion(...a),
      shouldTriggerFileCompletion: cur.shouldTriggerFileCompletion?.bind(cur),
      getSuggestions: async (...a) => {
        const r = await cur.getSuggestions(...a);
        return (
          r && {
            ...r,
            items: r.items.map((i) =>
              i.value === "bug" && i.label === "bug" ? { ...i, description: BUG_DESCRIPTION } : i,
            ),
          }
        );
      },
    }));
  });
}
