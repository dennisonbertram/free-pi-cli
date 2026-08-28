export const ERROR_CODES = [
  "daily_cap",
  // #40: the per-user ROLLING 5h spend cap (supplements daily_cap above).
  "rolling_cap",
  "concurrent",
  "concurrent_session",
  "context_ceiling",
  "upstream_error",
  "global_cap",
  "consent_required",
  "upgrade_required",
  // #23: over the tier's atomic per-hour completion-start ceiling (R6).
  "hourly_ceiling",
  // #23: a human-suspended account (abuse_user_state.tier = 'suspended') —
  // distinct from the classifier's own restrictions, which stay `daily_cap`.
  "account_review",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorResponse {
  code: ErrorCode;
  message: string;
}

// HTTP mapping per the plan's error contract (daily_cap/concurrent/context_ceiling/
// upstream_error/global_cap). consent_required has no server route yet (U3) and no
// mapping was specified upstream; 403 is a placeholder pending that unit.
export const ERROR_HTTP_STATUS = {
  daily_cap: 429,
  // #40: same shape as the other rate-based 429s (daily_cap/hourly_ceiling) —
  // a Retry-After header accompanies the response (routes/completions.ts).
  rolling_cap: 429,
  concurrent: 429,
  // #28 R19: a second session on the same JWT while the first's lease is
  // fresh. Deliberately a distinct code from "concurrent" (R11's one-live-
  // stream check). 409 Conflict, NOT 429 — this is a "you already hold a
  // session" state, not a rate limit, so the client must NOT auto-retry it
  // (a 429 made the pi SDK retry 3x and print the raw error 5 times — the
  // first real bug report, 2026-08-18). A 409 surfaces once.
  concurrent_session: 409,
  context_ceiling: 413,
  upstream_error: 502,
  global_cap: 503,
  consent_required: 403,
  // #37: below-minimum CLI on the completions gate. 426 Upgrade Required is
  // the RFC 7231 status made for exactly this.
  upgrade_required: 426,
  // #23 R6: same shape as the other rate-based 429s (daily_cap/concurrent) —
  // a standard Retry-After header accompanies the response (routes/completions.ts).
  hourly_ceiling: 429,
  // #23 R5: same status as consent_required — an access gate on account
  // state, not a rate limit.
  account_review: 403,
} satisfies Record<ErrorCode, number>;

export function assertExhaustiveErrorCode(code: never): never {
  throw new Error(`unhandled error code: ${String(code)}`);
}
