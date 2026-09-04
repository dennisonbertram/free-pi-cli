// U1: replaces pi's built-in startup header (hidden via quietStartup, see
// pi-launch.ts) with a short free-pi header — name, model, welcome line, and
// the five commands a user needs. KTD1/KTD2: a plain object component
// (render/invalidate/setExpanded), no @earendil-works/pi-tui dependency —
// same structural-typing approach as packages/pi-ads/src/style.ts.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** Structural subset of pi's `Theme` class actually used for styling. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Structural subset of pi's `TUI` actually used by the header component. */
export interface TuiLike {
  requestRender(): void;
}

// R2: fixed command list, in order, with descriptions. Names padded so every
// description starts at the same column.
const COMMANDS: ReadonlyArray<{ name: string; description: string }> = [
  { name: "/usage", description: "spend and remaining budget today" },
  { name: "/support", description: "visit today's advertiser" },
  { name: "/tos", description: "terms of service" },
  { name: "/privacy-policy", description: "privacy policy" },
  { name: "/buy-credits", description: "get more usage" },
  { name: "/close-other-session", description: "free a stuck session on another machine" },
  { name: "/update", description: "get the latest free-pi" },
];

const NAME_COLUMN = 24; // 2 leading spaces + longest name (20) + 2 spaces gap

const WELCOME_LINE =
  "Welcome to Free Pi, ad-supported inference. Please visit our advertisers to support us.";

// Split into two lines rather than one 106-char line, so it fits the 100-column
// truncation rule in headerLines without ever being cut off with an ellipsis.
const CONSENT_LINE_1 = "Usage is funded by ads and by training on your sessions. By using free-pi you consent.";
const CONSENT_LINE_2 = "See /tos and /privacy-policy.";

const EXPANDED_HINT_LINE = "esc interrupt · ctrl+c clear / exit · / commands · ! bash";

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 1)}…`;
}

/**
 * Pure line builder for R1-R3 (+ R6 when expanded). Testable with a fake theme.
 * `width` is applied to the plain text before styling, so escape bytes never
 * count toward it; a line that does not fit is shown dim and truncated.
 */
export function headerLines(
  theme: ThemeLike,
  modelName: string,
  expanded: boolean,
  width: number = Number.POSITIVE_INFINITY,
): string[] {
  // One column is reserved for the left margin added below.
  const inner = width - 1;
  const fit = (plain: string, styled: () => string): string =>
    plain.length <= inner ? styled() : theme.fg("dim", truncate(plain, inner));

  const titleRest = ` · ${modelName} · ctrl+o for help`;
  const title = fit(
    `free-pi${titleRest}`,
    () => `${theme.bold(theme.fg("accent", "free-pi"))}${theme.fg("dim", titleRest)}`,
  );

  const commandLines = COMMANDS.map(({ name, description }) => {
    const padded = `  ${name}`.padEnd(NAME_COLUMN, " ");
    return fit(`${padded}${description}`, () => `${padded}${theme.fg("dim", description)}`);
  });

  const dim = (plain: string) => fit(plain, () => theme.fg("dim", plain));

  const lines = [
    "",
    title,
    "",
    dim(WELCOME_LINE),
    "",
    dim(CONSENT_LINE_1),
    dim(CONSENT_LINE_2),
    "",
    ...commandLines,
    "",
  ];
  if (expanded) lines.push(dim(EXPANDED_HINT_LINE));
  // pi indents its own header and widget lines by one column; match it.
  return lines.map((line) => (line === "" ? line : ` ${line}`));
}

export interface CreateHeaderExtensionOptions {
  modelName: string;
}

/** R1-R7: registers the `free-pi-header` inline extension. session_start only. */
export function createHeaderExtension(opts: CreateHeaderExtensionOptions): InlineExtension {
  return {
    name: "free-pi-header",
    factory(pi: ExtensionAPI) {
      pi.on("session_start", (_event, ctx) => {
        ctx.ui.setHeader((tui: TuiLike, theme: ThemeLike) => {
          let expanded = false;
          return {
            render(width: number): string[] {
              return headerLines(theme, opts.modelName, expanded, width);
            },
            invalidate(): void {
              // no-op: headerLines has no cached state to drop.
            },
            setExpanded(next: boolean): void {
              expanded = next;
              tui.requestRender();
            },
          };
        });
      });
    },
  };
}
