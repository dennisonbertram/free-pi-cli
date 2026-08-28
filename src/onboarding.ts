// #63: first-run onboarding intro. Printed once — on a user's first run (the
// no-JWT path in run.ts), right after consent and ABOVE the device-login
// instructions they must read, so it is guaranteed seen even though the pi TUI
// takes over the screen afterwards. A returning user (JWT on disk) never sees
// it again. Skippable with FREEPI_NO_INTRO. Deliberately free-pi-specific: it
// does NOT duplicate the pi TUI's own key-hint line (pi prints that itself).
//
// Kept OUT of consent.ts and the pi-ads sandbox surface on purpose — it's a
// plain pre-TUI console message via the caller's `log`, nothing more.

export const INTRO_ENV_SKIP = "FREEPI_NO_INTRO";

export const INTRO_TEXT = `
Welcome to free-pi — a free coding agent in your terminal.

  • It's the pi coding agent, free to use. Ads in the terminal pay for the
    inference — ad content never reaches the model.
  • Tell it what to build, fix, or explain, like any coding assistant.
  • One session per account at a time. If you close the terminal, relaunch
    with "npx free-pi-cli" — or resume where you left off with
    "npx free-pi-cli --session <id>" (the id prints when you exit).

Set ${INTRO_ENV_SKIP}=1 to skip this next time.
`.trim();

/** True when the user opted out of the first-run intro via env. */
export function introSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[INTRO_ENV_SKIP];
  return v === "1" || v === "true";
}

/**
 * Print the first-run intro unless the user opted out. Pure I/O via `log` so
 * run.ts stays testable; call it only on the first-run (no-JWT) path.
 */
export function showIntro(log: (message: string) => void, env: NodeJS.ProcessEnv = process.env): void {
  if (introSkipped(env)) return;
  log(`\n${INTRO_TEXT}\n`);
}
