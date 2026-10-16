// 0.4.2: pi appends extension statuses (the credits meter) as one extra footer
// line, left-aligned, and collapses any padding we put in the status text. So we
// wrap the footer's render() on our own InteractiveMode instance and right-align
// that last line. pi assigns `mode.footer` once, in its constructor.
const ANSI = /\x1b\[[0-9;]*m/g;

// Only lines whose visible text is single-column Latin-1 (the credits meter) are
// measured; anything else (emoji, CJK, OSC 8 links from another extension) is left
// as pi drew it, so padding can never push a line past the terminal width.
// ponytail: no pi-tui visibleWidth here; widen if a status ever needs wide glyphs aligned.
const SIMPLE = /^[\x20-\x7e\xa0-\xff]*$/;

export function installFooterRightAlign(mode: object): void {
  const footer = (mode as { footer: { render(w: number): string[] } }).footer;
  const render = footer.render.bind(footer);
  footer.render = (w: number) => {
    const lines = render(w);
    if (lines.length <= 2) return lines;
    const last = lines[lines.length - 1]!;
    const text = last.replace(ANSI, "");
    if (!SIMPLE.test(text)) return lines;
    // Never exceed width: when the line already fills it, pad nothing.
    return [...lines.slice(0, -1), " ".repeat(Math.max(0, w - text.length)) + last];
  };
}
