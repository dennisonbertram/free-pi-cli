// Pure argv parsing for the three local commands (help / version / logout),
// extracted from index.ts (untestable: main() runs on import) as a test seam.
//
// Privacy note, same invariant as run()'s decline path: none of the commands
// parsed here ever contact the free-pi server — they print or touch local
// files and exit. Only { kind: "run" } proceeds into the consent-gated flow.
import { CLI_VERSION } from "./version";

export type CliCommand =
  | { kind: "run" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "logout" }
  | { kind: "unknown"; arg: string };

export const HELP_TEXT = `
free-pi — free AI coding in your terminal; ads pay for the inference.

Usage:
  free-pi-cli            start the coding agent (first run: consent + GitHub sign-in)
  free-pi-cli logout     remove the stored sign-in token; the next run signs in again
  free-pi-cli --version  print the CLI version
  free-pi-cli --help     show this help

Environment:
  FREEPI_BASE_URL        override the backend base URL (default https://api.freepi.ai)
  FREEPI_NO_AUTO_UPDATE  disable in-place self-update for this run
`.trim();

export function versionLine(): string {
  return `free-pi-cli ${CLI_VERSION}`;
}

/**
 * argv is process.argv.slice(2). Anything unrecognized — including trailing
 * args after a valid command — is { kind: "unknown" } so index.ts can show
 * help and exit nonzero, rather than silently ignoring input the way the
 * arg-less CLI used to (a typo'd `free-pi-cli loguot` must not quietly start
 * a full agent session and burn ad-funded tokens).
 */
export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "run" };

  let kind: "help" | "version" | "logout";
  if (first === "--help" || first === "-h" || first === "help") kind = "help";
  else if (first === "--version" || first === "-v") kind = "version";
  else if (first === "logout") kind = "logout";
  else return { kind: "unknown", arg: first };

  if (rest.length > 0) return { kind: "unknown", arg: rest[0] as string };
  return { kind };
}
