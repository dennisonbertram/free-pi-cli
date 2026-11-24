// #23: asks before a turn spends the user's *bonus* credits — the purchased
// plus granted balance the server reports as `bonus_credits` on GET /me.
// The free daily allowance still spends first and needs no prompt; only the
// moment the allowance is gone AND a balance exists does the turn pause.
//
// Two states only, `ask` (default) and `auto`. There is deliberately no
// "never": declining one turn is how a user keeps the balance, and the server
// keeps a free slow/fallback lane once the allowance is gone, so a decline is
// never a dead end. No bonus credits left also passes straight through — the
// existing 429/limit notice path says it better than a dialog would.
//
// This is an inline extension (`free-pi-bonus-credits`) rather than part of
// free-pi-commands because it is a turn gate, not a slash command: it reads
// ctx.ui and the editor on the `input` event.
import type {
  ExtensionAPI,
  ExtensionContext,
  InlineExtension,
  InputEvent,
  InputEventResult,
} from "@earendil-works/pi-coding-agent";
import type { MeResponse } from "@freepi/shared";
import { readBonusCreditMode, writeSpendBonusCredits } from "./cli-config";

export type BonusGateDecision = "proceed" | "ask";

export interface BonusGateInput {
  mode: "ask" | "auto";
  remainingCreditsToday: number;
  bonusCredits: number;
}

/**
 * Pure decision seam: the whole rule, in order, with no I/O.
 *
 * Order matters. `auto` wins first so an opted-in user never waits on /me.
 * `remaining > 0` is next: while the free allowance covers the turn, nothing
 * of the user's is being spent, so nothing to confirm. `bonusCredits <= 0`
 * last: with nothing to protect, a dialog would only block a turn the server
 * can still serve on its free lane.
 */
export function decideBonusGate(i: BonusGateInput): BonusGateDecision {
  if (i.mode === "auto") return "proceed";
  if (i.remainingCreditsToday > 0) return "proceed";
  if (i.bonusCredits <= 0) return "proceed";
  return "ask";
}

// The three answers, in the order the dialog shows them. Exported so the
// command's wording and the tests can never drift from the handler's.
export const BONUS_GATE_USE = "Use bonus credits";
export const BONUS_GATE_NOT_NOW = "Not now";
export const BONUS_GATE_ALWAYS = "Always use bonus credits (don't ask again)";

export const BONUS_GATE_DECLINED_NOTICE = "Nothing sent — your bonus credits are untouched.";

export interface CreateBonusCreditGateOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  configPath: string;
  fetchImpl?: typeof fetch;
}

interface CreditState {
  remainingCreditsToday: number;
  bonusCredits: number;
}

/**
 * One GET /me per submitted prompt, no caching: the balance moves as the user
 * spends, and a stale figure in a money dialog is worse than one extra
 * request. Any failure (offline, non-2xx, old server missing the fields,
 * timeout) returns undefined so the caller can fail open.
 */
async function readCreditState(opts: CreateBonusCreditGateOptions): Promise<CreditState | undefined> {
  try {
    const token = await opts.getToken();
    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(`${opts.baseUrl}/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return undefined;
    const me = (await res.json()) as Partial<MeResponse>;
    const remaining = me.remaining_credits_today;
    const bonus = me.bonus_credits;
    // Both are optional on the schema (older servers omit them); a non-number
    // must not become NaN and decide the gate by accident.
    if (typeof remaining !== "number" || typeof bonus !== "number") return undefined;
    return { remainingCreditsToday: remaining, bonusCredits: bonus };
  } catch {
    return undefined;
  }
}

/** The `input` handler. Returns pi's InputEventResult; never throws. */
async function handleInput(
  event: InputEvent,
  ctx: ExtensionContext,
  opts: CreateBonusCreditGateOptions,
): Promise<InputEventResult> {
  // Only a person at the keyboard gets a dialog. pi also emits `input` for
  // rpc and extension sources; prompting there would block a programmatic
  // turn on a question nobody is looking at.
  if (event.source !== "interactive") return { action: "continue" };

  // Read the mode fresh every prompt so /spend-bonus-credits takes effect
  // without a restart.
  const mode = readBonusCreditMode(opts.configPath);
  if (mode === "auto") return { action: "continue" };

  const state = await readCreditState(opts);
  if (!state) return { action: "continue" };

  if (decideBonusGate({ mode, ...state }) !== "ask") return { action: "continue" };

  // `select` takes only a title, so the balance is its second line.
  const choice = await ctx.ui.select(
    `Your free allowance is used up\nYou have ${state.bonusCredits.toLocaleString("en-US")} bonus credits left.`,
    [BONUS_GATE_USE, BONUS_GATE_NOT_NOW, BONUS_GATE_ALWAYS],
  );

  if (choice === BONUS_GATE_USE) return { action: "continue" };

  if (choice === BONUS_GATE_ALWAYS) {
    // The turn proceeds either way (the user just answered), but a write that
    // failed must not be reported as remembered — they would be asked again
    // next prompt with no idea why.
    const saved = writeSpendBonusCredits(opts.configPath, true);
    ctx.ui.notify(
      saved
        ? "Bonus credits will be used automatically from now on. /spend-bonus-credits turns that back off."
        : "Couldn't save that setting, so you'll be asked again next time. /spend-bonus-credits tries again.",
      saved ? "info" : "error",
    );
    return { action: "continue" };
  }

  // "Not now", or the dialog was dismissed. pi clears the editor before
  // session.prompt(), so the draft has to be put back or declining swallows
  // what the user typed. Attached images cannot be restored (acceptable:
  // the text is what is usually painful to lose).
  ctx.ui.setEditorText(event.text);
  ctx.ui.notify(BONUS_GATE_DECLINED_NOTICE, "info");
  return { action: "handled" };
}

export function createBonusCreditGateExtension(opts: CreateBonusCreditGateOptions): InlineExtension {
  return {
    name: "free-pi-bonus-credits",
    factory(pi: ExtensionAPI) {
      pi.on("input", async (event, ctx) => {
        try {
          return await handleInput(event, ctx, opts);
        } catch {
          // Fail open: a gate bug must never block a turn.
          return { action: "continue" };
        }
      });
    },
  };
}
