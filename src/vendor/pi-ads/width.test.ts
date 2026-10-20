// Cell-width regression: a widget line wider than the terminal throws in pi's
// renderer ("Rendered line N exceeds terminal width") and stops the TUI, so
// every line the ad widget returns must measure <= the render width in
// terminal cells (pi-tui's visibleWidth), not in JS string length. Wide
// characters (CJK, emoji) take 2 cells each; tiny widths must not overflow.
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AdCreative } from "@freepi/shared";
import { adWidget } from "./style";

const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
const URL_ = "https://freepi.ai/c/tok-1";
const MIN = 60;

function draw(creative: Partial<AdCreative>, width: number, adMinColumns = MIN): string[] {
  const c: AdCreative = { headline: "Headline", body: "Body copy", cta: "Click here", accent: "#fff", ...creative };
  return adWidget(c, URL_, adMinColumns)(undefined, theme).render(width);
}

function expectFits(lines: string[], width: number) {
  for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
}

function expectFramed(lines: string[], width: number) {
  expect(lines.length).toBe(5);
  expectFits(lines, width);
  expect(new Set(lines.map(visibleWidth)).size).toBe(1); // borders line up
}

describe("wide characters are measured in terminal cells", () => {
  for (const width of [60, 80]) {
    test(`CJK headline and body at width ${width} fit and stay aligned`, () => {
      const lines = draw({ headline: "界".repeat(40), body: "漢字".repeat(60) }, width);
      expectFramed(lines, width);
    });

    test(`emoji-heavy CTA at width ${width} fits and stays aligned`, () => {
      const lines = draw({ cta: "🚀🔥✨ Start building now 🎉🎉🎉 ".repeat(4) }, width);
      expectFramed(lines, width);
    });
  }

  test("a short CJK headline that needs no truncation is padded to the same width as the borders", () => {
    expectFramed(draw({ headline: "界界界", body: "日本語", cta: "始める" }, 80), 80);
  });

  test("CJK in the plain fallback fits", () => {
    const lines = draw({ headline: "界".repeat(40), cta: "始める".repeat(10) }, 50);
    expect(lines.length).toBe(1);
    expectFits(lines, 50);
  });
});

describe("tiny widths never overflow", () => {
  for (const width of [1, 5, 10, 11]) {
    test(`plain fallback at width ${width} fits`, () => {
      const lines = draw({}, width);
      expect(lines.length).toBeLessThanOrEqual(1);
      expectFits(lines, width);
    });
  }

  test("width below 1 draws nothing", () => {
    expect(draw({}, 0)).toEqual([]);
  });

  test("a low AD_MIN_COLUMNS cannot make the framed card overflow a narrow terminal", () => {
    for (const width of [10, 20, 24]) expectFits(draw({}, width, 0), width);
  });
});
