// 0.2.6: bundled changelog highlights for the what's-new-on-startup banner
// (whats-new.ts). The published package ships only `dist` + README (see
// package.json `files`), so CHANGELOG.md — the canonical human doc — would not
// reach users; this module IS bundled into the build. Keep the newest entry's
// version in sync with package.json (changelog.test.ts asserts it).

export interface ChangelogEntry {
  version: string;
  highlights: string[];
}

export const CHANGELOG_HIGHLIGHTS: ChangelogEntry[] = [
  {
    version: "0.2.14",
    highlights: [
      "No user-facing changes. This version tests the automated npm publish from GitHub Actions.",
    ],
  },
  {
    version: "0.2.13",
    highlights: [
      "Purchased balance is now shown as credits — $5 buys 50,000 credits, $10 buys 100,000.",
      "The usage summary is cleaner: your free allowance still shows as a percentage, with token counts, and no request tally.",
    ],
  },
  {
    version: "0.2.12",
    highlights: [
      "New: /buy-credits and /usage slash commands — work instantly, even when you are out of usage.",
      "Free usage is shown as a percentage, never a dollar figure; purchased credit stays in dollars.",
      "Clearer messages: one readable line when a request is rejected, a heads-up at 80% of your daily allowance, and a confirmation when a purchase lands.",
    ],
  },
  {
    version: "0.2.11",
    highlights: [
      "Out of free usage? You can now buy more — $5 or $10 packs, card or USDC. Ask pi to \"buy credits\" or follow the link in the out-of-usage notice.",
      "The out-of-usage notice now comes from the server, and `free_pi_usage` shows your purchased balance.",
    ],
  },
  {
    version: "0.2.10",
    highlights: [
      "free-pi now installs an exact, tested version of the underlying agent — an upstream release can no longer change your CLI without us testing it first.",
    ],
  },
  {
    version: "0.2.9",
    highlights: [
      "Windows: self-update and browser sign-in actually work now — both had been broken since they shipped.",
      "Running without a terminal (CI, piped input) now says so and exits, instead of hanging or quietly doing nothing.",
      "New: `free-pi-cli logout`, `--version` and `--help`.",
    ],
  },
  {
    version: "0.2.8",
    highlights: [
      "You can now pick between models — run /model to see the list and switch (when the server offers more than one).",
    ],
  },
  {
    version: "0.2.7",
    highlights: [
      "The model list now reliably shows just the free-pi model — including HuggingFace, AWS, and Vertex — while leaving every credential in your shell untouched.",
    ],
  },
  {
    version: "0.2.6",
    highlights: [
      "New: /close-other-session clears a stuck session so you're never locked out waiting.",
      "New: /whats-new and /update commands.",
      "The model list now shows just the free-pi model (add your own keys with /login).",
      "This 'what's new' note, shown once after an update.",
    ],
  },
  {
    version: "0.2.5",
    highlights: [
      "The model you're actually using now shows correctly in the status line.",
      "Free Ox Alpha trial — a frontier preview model, on the house.",
    ],
  },
  {
    version: "0.2.4",
    highlights: ["Fixed a startup crash on older Node versions."],
  },
  {
    version: "0.2.3",
    highlights: ["Friendly 'please upgrade Node' message instead of a crash mid-request."],
  },
];

/** Highlights for a specific version, or undefined if none are recorded. */
export function highlightsFor(version: string): string[] | undefined {
  return CHANGELOG_HIGHLIGHTS.find((e) => e.version === version)?.highlights;
}
