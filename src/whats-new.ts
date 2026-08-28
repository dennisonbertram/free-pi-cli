// 0.2.6: "what's new" on startup. Shows the running version's changelog
// highlights once, only after an update, then advances a last-seen marker in
// the agent dir. Best-effort by construction — any file I/O error resolves to
// "show nothing" and never throws, so a bad state file can never block launch
// (same offline-safe posture as update-check.ts).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compareVersions } from "@freepi/shared";
import { getLastSeenVersionPath } from "./paths";
import { highlightsFor } from "./changelog";

/**
 * Returns the what's-new banner to print, or undefined when nothing should
 * show. Rules (KTD4):
 *   - first run (no marker) → seed the marker, show nothing (a new user gets
 *     the onboarding intro, not a "what's new");
 *   - marker older than cliVersion (an update) with recorded highlights → show
 *     them once, advance the marker;
 *   - otherwise (same version, downgrade, or no highlights) → show nothing.
 * The marker is always advanced to cliVersion.
 */
export function maybeWhatsNew(cliVersion: string, agentDir?: string): string | undefined {
  try {
    const path = getLastSeenVersionPath(agentDir);
    const lastSeen = existsSync(path) ? readFileSync(path, "utf-8").trim() : undefined;
    writeLastSeen(path, cliVersion); // always advance the marker to the running version

    if (lastSeen === undefined) return undefined; // first run: seeded, nothing to announce
    if (compareVersions(lastSeen, cliVersion) !== -1) return undefined; // not an upgrade

    const highlights = highlightsFor(cliVersion);
    if (!highlights || highlights.length === 0) return undefined; // nothing recorded for it

    return [`What's new in free-pi ${cliVersion}:`, ...highlights.map((h) => `  • ${h}`)].join("\n");
  } catch {
    return undefined;
  }
}

function writeLastSeen(path: string, version: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, version, "utf-8");
}
