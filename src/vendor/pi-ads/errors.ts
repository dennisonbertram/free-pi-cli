// Error-code -> message mapping (R10 client half) plus the one live wiring
// this unit ships.
//
// Investigated mechanism: pi exposes provider HTTP responses to extensions
// only via the `after_provider_response` event, which carries `status`
// (number) and `headers` (Record<string,string>) — never the response body
// (confirmed against @earendil-works/pi-coding-agent 0.84.2's own
// docs/extensions.md and its examples/extensions/provider-payload.ts, which
// logs exactly `[${event.status}] ${JSON.stringify(event.headers)}` and
// nothing else). The proxy's error contract puts the distinguishing `code`
// field in the JSON body (`{code, message}`), and two codes — daily_cap and
// concurrent — share HTTP 429, so status alone can't disambiguate them.
//
// U4 (the completions proxy) hasn't landed yet in this worktree, so there is
// no live error to wire against, and guessing at that wiring would be
// exactly the kind of unverified assumption this repo's rules forbid.
// Documented choice for this unit: use the one signal that already is real
// and already polled every turn — GET /me's `remaining_usd_today` — to
// detect the one code that's actually observable that way: daily_cap. The
// meter widget (meter.ts) renders this message in place of the normal
// "remaining: $X.XX" line whenever the budget is exhausted.
//
// The other four codes (concurrent, context_ceiling, upstream_error,
// global_cap) have no clean signal in the current pi extension API. When U4
// ships, the natural integration point is `after_provider_response`,
// combining `status` with the meter's last-known remaining budget to
// disambiguate the shared 429 (remaining <= 0 -> daily_cap, else ->
// concurrent). Deferred rather than guessed.
import { assertExhaustiveErrorCode, type ErrorCode } from "@freepi/shared";

export function mapErrorCode(code: ErrorCode): string {
  switch (code) {
    case "daily_cap":
      return "out of free tokens today, resets at 00:00 UTC";
    case "rolling_cap":
      return "over the rolling spend cap on the free tier — wait for the Retry-After window";
    case "concurrent":
      return "only one request at a time on the free tier — wait for the current one to finish";
    case "concurrent_session":
      return "another free-pi session for your account is already active";
    case "context_ceiling":
      return "this conversation is too large for free-pi's context limit";
    case "upstream_error":
      return "upstream model provider had an issue — retry";
    case "global_cap":
      return "free-pi is over its daily budget — back tomorrow";
    case "consent_required":
      return "consent required — restart free-pi to review the terms";
    case "upgrade_required":
      return "your free-pi-cli is out of date — run `npx free-pi-cli@latest`";
    case "hourly_ceiling":
      return "too many requests this hour on the free tier — wait for the Retry-After window";
    case "account_review":
      return "this account is under review — contact support";
    default:
      return assertExhaustiveErrorCode(code);
  }
}

/**
 * The one error code this unit can honestly detect: GET /me is already
 * polled every turn (R7's meter), and a non-positive remaining budget means
 * the per-user daily cap is spent. See module comment above for why the
 * other four codes aren't wired here.
 */
export function inferErrorFromRemainingBudget(remainingUsdToday: number): ErrorCode | undefined {
  return remainingUsdToday <= 0 ? "daily_cap" : undefined;
}
