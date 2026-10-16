import { describe, expect, test } from "bun:test";
import { installFooterRightAlign } from "../src/footer-align";

const mk = (lines: string[]) => ({ footer: { render: (_w: number) => lines } });

describe("installFooterRightAlign", () => {
  test("right-aligns only the status line (third line)", () => {
    const m = mk(["pwd", "stats", "14,613 + 100,000 credits"]);
    installFooterRightAlign(m);
    const out = m.footer.render(40);
    expect(out.slice(0, 2)).toEqual(["pwd", "stats"]);
    expect(out[2]).toBe(" ".repeat(40 - 24) + "14,613 + 100,000 credits");
  });

  test("ignores ANSI codes when measuring and never exceeds width", () => {
    const m = mk(["a", "b", "\x1b[2mhi\x1b[0m"]);
    installFooterRightAlign(m);
    expect(m.footer.render(10)[2]).toBe(" ".repeat(8) + "\x1b[2mhi\x1b[0m");
    const n = mk(["a", "b", "x".repeat(30)]);
    installFooterRightAlign(n);
    expect(n.footer.render(10)[2]).toBe("x".repeat(30));
  });

  test("slow-lane middle dot is still aligned", () => {
    const m = mk(["a", "b", "0 credits · slow lane"]);
    installFooterRightAlign(m);
    expect(m.footer.render(30)[2]).toBe(" ".repeat(9) + "0 credits · slow lane");
  });

  test("wide glyphs or non-SGR escapes are left as pi drew them (no over-width line)", () => {
    for (const last of ["100 credits 🚀 ready", "100 credits 中文", "\x1b]8;;https://x\x07docs\x1b]8;;\x07"]) {
      const m = mk(["a", "b", last]);
      installFooterRightAlign(m);
      expect(m.footer.render(40)[2]).toBe(last);
    }
  });

  test("leaves a two-line footer alone", () => {
    const m = mk(["a", "b"]);
    installFooterRightAlign(m);
    expect(m.footer.render(40)).toEqual(["a", "b"]);
  });
});
