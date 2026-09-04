// ALL rendering/styling for pi-ads lives in this one module (R6). Blade
// Runner 2049-leaning terminal aesthetic: box-drawing frame, a scanline-style
// glyph accent (░▒▓) in the header, theme-aware accent color pulled from
// pi's active theme so the frame matches whatever theme the user has picked.
//
// Every function here is pure (string in, string out) so it's testable
// without a real pi TUI: callers pass a `ThemeLike` (the real `Theme` class
// from @earendil-works/pi-coding-agent satisfies this structurally) and an
// explicit `columns` width instead of reading the terminal directly.
import { createHash } from "node:crypto";
import type { AdCreative } from "@freepi/shared";

/** Structural subset of pi's `Theme` class actually used for styling. */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

// ---------------------------------------------------------------------------
// Sanitizer — strips ANSI/OSC/control sequences from every creative text
// field before it's ever assembled into a widget line. Ad copy is untrusted
// input; nothing here may reach the terminal un-neutralized.
// ---------------------------------------------------------------------------

const OSC_RE = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g; // ESC ] ... (BEL | ST)
const CSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g; // ESC [ ... final byte
const C1_RE = /[\x80-\x9f]/g; // 8-bit C1 control range (alternate ESC triggers)
const C0_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g; // C0 controls + DEL, excl. \t\r\n (handled separately)

export function sanitizeText(input: string): string {
  return input
    .replace(OSC_RE, "")
    .replace(CSI_RE, "")
    .replace(/\x1b/g, "") // any leftover ESC byte from an unrecognized sequence
    .replace(C1_RE, "")
    .replace(/[\t\r\n]+/g, " ")
    .replace(C0_RE, "")
    .trim();
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function truncate(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 1) return text.slice(0, maxWidth);
  return `${text.slice(0, maxWidth - 1)}…`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}

/**
 * OSC 8 hyperlink. Terminals that support OSC 8 render `text` as clickable;
 * terminals that don't simply ignore the invisible control bytes and show
 * `text` as-is. We deliberately make `text` the human CTA (which names the
 * destination, e.g. "get the skill @ slop.cash") rather than the raw click
 * URL: the click URL is a long, random `/c/<token>` tracking redirect that
 * looks untrustworthy in the terminal and suppresses the click (first paid-ad
 * feedback, 2026-08-18, #61). Clickable where OSC 8 is supported; a clean,
 * legible destination where it is not.
 */
function osc8(text: string, url: string, id?: string): string {
  const params = id ? `id=${id}` : "";
  return `\x1b]8;${params};${url}\x07${text}\x1b]8;;\x07`;
}

// ---------------------------------------------------------------------------
// Ad rendering
// ---------------------------------------------------------------------------

/** Framed ad card: box-drawing border, glyph accent header, theme-aware accent. */
export function renderAdCard(
  creative: AdCreative,
  clickUrl: string,
  theme: ThemeLike,
  columns: number,
): string[] {
  const headline = sanitizeText(creative.headline);
  const body = sanitizeText(creative.body);
  const cta = sanitizeText(creative.cta);
  const url = sanitizeText(clickUrl);

  // -6, not -4: pi's TUI draws widget lines behind a 1-2 column gutter, so a
  // line built to exactly `columns` wraps its closing border onto the next
  // row (witnessed live at 80/100/140 cols on 2026-08-15).
  const innerWidth = Math.max(20, columns - 6);
  const label = " AD ░▒▓ ";
  const top = `┌${label}${"─".repeat(Math.max(0, innerWidth + 2 - label.length))}┐`;
  const bottom = `└${"─".repeat(innerWidth + 2)}┘`;

  // KTD2: a short hex digest of the (sanitized) click URL, not the click
  // token itself, so the id visible in the escape stream is stable for
  // hover-grouping without doubling as a second copy of the tracker.
  const linkId = createHash("sha256").update(url).digest("hex").slice(0, 12);

  const row = (text: string, opts?: { bold?: boolean }): string => {
    const plain = pad(truncate(text, innerWidth), innerWidth);
    let styled = theme.fg("accent", plain);
    if (opts?.bold) styled = theme.bold(styled);
    return `│ ${styled} │`;
  };

  // R1/R2: every row — including both borders — carries the same OSC 8
  // link and id, so a terminal that groups by id treats the whole card as
  // one clickable link, not just the CTA row.
  return [
    theme.fg("borderAccent", osc8(top, url, linkId)),
    osc8(row(headline, { bold: true }), url, linkId),
    osc8(row(body), url, linkId),
    osc8(row(`▸ ${cta}`), url, linkId),
    theme.fg("borderAccent", osc8(bottom, url, linkId)),
  ];
}

/** Below adMinColumns: one plain line, no frame. Still an OSC 8 link (degrades to plain text). */
export function renderPlainAdLine(
  creative: AdCreative,
  clickUrl: string,
  theme: ThemeLike,
  columns: number,
): string {
  const headline = sanitizeText(creative.headline);
  const cta = sanitizeText(creative.cta);
  const url = sanitizeText(clickUrl);
  // #61: same as the card — the CTA carries the destination; the raw tracker
  // URL is the OSC-8 target only, never visible text.
  const plain = truncate(`AD ▚ ${headline} — ${cta}`, Math.max(10, columns - 2));
  return theme.fg("dim", osc8(plain, url));
}

// ---------------------------------------------------------------------------
// Meter / error line
// ---------------------------------------------------------------------------

export function renderErrorLine(message: string, theme: ThemeLike): string {
  return theme.fg("error", message);
}
