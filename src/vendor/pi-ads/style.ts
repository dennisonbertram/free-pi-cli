// ALL rendering/styling for pi-ads lives in this one module (R6). Blade
// Runner 2049-leaning terminal aesthetic: box-drawing frame, a scanline-style
// glyph accent (░▒▓) in the header, theme-aware accent color pulled from
// pi's active theme so the frame matches whatever theme the user has picked.
//
// Every function here is pure (string in, string out) so it's testable
// without a real pi TUI: callers pass a `ThemeLike` (the real `Theme` class
// from @earendil-works/pi-coding-agent satisfies this structurally) and an
// explicit `columns` width instead of reading the terminal directly.
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
 * `text` as-is — which is why `text` is always the visible click URL itself
 * (plain-URL fallback is automatic, not a separate code path).
 */
function osc8(text: string, url: string): string {
  return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;
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

  const row = (text: string, opts?: { linkUrl?: string; bold?: boolean }): string => {
    const plain = pad(truncate(text, innerWidth), innerWidth);
    let styled = theme.fg("accent", plain);
    if (opts?.bold) styled = theme.bold(styled);
    const content = opts?.linkUrl ? osc8(styled, opts.linkUrl) : styled;
    return `│ ${content} │`;
  };

  return [
    theme.fg("borderAccent", top),
    row(headline, { bold: true }),
    row(body),
    row(`▸ ${cta}  ${url}`, { linkUrl: url }),
    theme.fg("borderAccent", bottom),
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
  const plain = truncate(`AD ▚ ${headline} — ${cta} ${url}`, Math.max(10, columns - 2));
  return theme.fg("dim", osc8(plain, url));
}

// ---------------------------------------------------------------------------
// Meter / error line
// ---------------------------------------------------------------------------

export function renderMeterLine(remainingUsdToday: number, theme: ThemeLike): string {
  return theme.fg("dim", `free budget today: $${remainingUsdToday.toFixed(2)} remaining`);
}

export function renderErrorLine(message: string, theme: ThemeLike): string {
  return theme.fg("error", message);
}
