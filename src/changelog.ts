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
