// Display peg (#credits): a purchased dollar of inference value is shown to the
// user as this many "credits". Chosen so the packs land on round numbers
// ($3.75 -> 50,000 and $7.50 -> 100,000). DISPLAY-ONLY: it never re-enters
// billing or a cap comparison — the ledger (users.credit_usd) and every burn
// stay in USD. The 40000/3 form is exact for both packs. Lives here in
// @freepi/shared so the server (stripe/auth) and the client (meter, CLI) share
// one definition and can never drift.
export const CREDITS_PER_USD = 40000 / 3;

/** USD (decimal string or number) -> whole credits, for display only. */
export function usdToCredits(usd: string | number): number {
  return Math.round(Number(usd) * CREDITS_PER_USD);
}
