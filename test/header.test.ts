import { describe, expect, test } from "bun:test";
import { createHeaderExtension, headerLines, type ThemeLike, type TuiLike } from "../src/header";

/** InlineExtension is a union (bare factory fn | {name, factory}); our
 * factory always returns the object form. */
function asObjectExtension(ext: unknown): { name: string; factory: (pi: unknown) => void } {
  return ext as { name: string; factory: (pi: unknown) => void };
}

/** Fake theme: wraps calls in readable markers instead of real ANSI, so
 * assertions can check nesting/placement without decoding escape codes. */
function fakeTheme(): ThemeLike {
  return {
    fg: (color, text) => `<fg:${color}>${text}</fg>`,
    bold: (text) => `<b>${text}</b>`,
  };
}

const MODEL = "DeepSeek V4 Flash";

describe("headerLines (R1-R3, R6)", () => {
  test("collapsed: exactly 16 lines in R1 order", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    expect(lines).toHaveLength(16);
    expect(lines[0]).toBe(""); // blank
    expect(lines[1]).toContain("free-pi");
    expect(lines[1]).toContain(MODEL);
    expect(lines[1]).toContain("ctrl+o for help");
    expect(lines[2]).toBe(""); // blank
    expect(lines[3]).toContain("Welcome to Free Pi, ad-supported inference. Please visit our advertisers to support us.");
    expect(lines[4]).toBe(""); // blank
    expect(lines[5]).toContain("Usage is funded by ads and by training on your sessions. By using free-pi you consent.");
    expect(lines[6]).toContain("See /tos and /privacy-policy.");
    expect(lines[7]).toBe(""); // blank
    // seven command lines
    expect(lines[8]).toContain("/usage");
    expect(lines[9]).toContain("/support");
    expect(lines[10]).toContain("/tos");
    expect(lines[11]).toContain("/privacy-policy");
    expect(lines[12]).toContain("/buy-credits");
    expect(lines[13]).toContain("/close-other-session");
    expect(lines[14]).toContain("/update");
    expect(lines[15]).toBe(""); // trailing blank
  });

  test("R2: command lines are in order with descriptions, each starting at the same column", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    const commandLines = lines.slice(8, 15);
    const expectedNames = ["/usage", "/support", "/tos", "/privacy-policy", "/buy-credits", "/close-other-session", "/update"];
    const expectedDescriptions = [
      "spend and remaining budget today",
      "visit today's advertiser",
      "terms of service",
      "privacy policy",
      "get more usage",
      "free a stuck session on another machine",
      "get the latest free-pi",
    ];
    for (const [i, line] of commandLines.entries()) {
      expect(line.startsWith(`   ${expectedNames[i]}`)).toBe(true);
      expect(line).toContain(expectedDescriptions[i]);
    }
    // Same column: the description marker `<fg:dim>` starts at the same index in every line.
    const columns = commandLines.map((l) => l.indexOf("<fg:dim>"));
    expect(new Set(columns).size).toBe(1);
  });

  test("R3: style markers — free-pi is bold+accent, welcome/descriptions dim, command names unstyled", () => {
    const lines = headerLines(fakeTheme(), MODEL, false);
    expect(lines[1]).toContain("<b><fg:accent>free-pi</fg></b>");
    expect(lines[3]).toBe(` <fg:dim>Welcome to Free Pi, ad-supported inference. Please visit our advertisers to support us.</fg>`);
    for (const line of lines.slice(8, 15)) {
      expect(line).toContain("<fg:dim>");
      // the command name itself (before the dim-wrapped description) carries no marker
      const namePart = line.slice(0, line.indexOf("<fg:dim>"));
      expect(namePart).not.toContain("<fg:");
      expect(namePart).not.toContain("<b>");
    }
  });

  test("R6: expanded appends one dim hint line; collapsed omits it", () => {
    const collapsed = headerLines(fakeTheme(), MODEL, false);
    const expanded = headerLines(fakeTheme(), MODEL, true);
    expect(expanded).toHaveLength(collapsed.length + 1);
    expect(expanded.at(-1)).toBe(
      " <fg:dim>esc interrupt · ctrl+c clear / exit · / commands · ! bash</fg>",
    );
  });

  test("model name appears verbatim", () => {
    const lines = headerLines(fakeTheme(), "Custom Model Name", false);
    expect(lines[1]).toContain("Custom Model Name");
  });

  test("R7: no line contains ad creative markers", () => {
    const lines = headerLines(fakeTheme(), MODEL, true);
    for (const line of lines) {
      expect(line).not.toContain("AD ░▒▓");
    }
  });
});

describe("createHeaderExtension (registration, R1/R6)", () => {
  function stubPi() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    return {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
      },
      handlers,
    };
  }

  function stubUi() {
    let factory: ((tui: TuiLike, theme: ThemeLike) => unknown) | undefined;
    let calls = 0;
    return {
      setHeader: (f: (tui: TuiLike, theme: ThemeLike) => unknown) => {
        factory = f;
        calls++;
      },
      get factory() {
        return factory;
      },
      get calls() {
        return calls;
      },
    };
  }

  test("registers only session_start", () => {
    const pi = stubPi();
    asObjectExtension(createHeaderExtension({ modelName: MODEL })).factory(pi as never);
    expect([...pi.handlers.keys()]).toEqual(["session_start"]);
  });

  test("session_start calls setHeader exactly once; render(100) matches headerLines", () => {
    const pi = stubPi();
    asObjectExtension(createHeaderExtension({ modelName: MODEL })).factory(pi as never);
    const ui = stubUi();
    let requestRenderCalls = 0;
    const tui: TuiLike = { requestRender: () => requestRenderCalls++ };

    pi.handlers.get("session_start")!({}, { ui });
    expect(ui.calls).toBe(1);

    const component = ui.factory!(tui, fakeTheme()) as {
      render(width: number): string[];
      invalidate(): void;
      setExpanded(v: boolean): void;
    };
    expect(component.render(100)).toEqual(headerLines(fakeTheme(), MODEL, false));

    component.setExpanded(true);
    expect(requestRenderCalls).toBe(1);
    expect(component.render(100)).toEqual(headerLines(fakeTheme(), MODEL, true));

    component.setExpanded(false);
    expect(requestRenderCalls).toBe(2);
    expect(component.render(100)).toEqual(headerLines(fakeTheme(), MODEL, false));

    // invalidate is a no-op that doesn't throw
    expect(() => component.invalidate()).not.toThrow();
  });
});

describe("headerLines width", () => {
  const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `<b>${t}</b>` };
  test("styled lines are never truncated by their escape bytes at 100 columns", () => {
    const lines = headerLines(theme, "DeepSeek V4 Flash", true, 100);
    expect(lines[3]).toBe(` <dim>${"Welcome to Free Pi, ad-supported inference. Please visit our advertisers to support us."}</dim>`);
    expect(lines.some((l) => l.includes("…"))).toBe(false);
  });
  test("a line wider than the terminal is shown dim and truncated on plain text", () => {
    const lines = headerLines(theme, "DeepSeek V4 Flash", false, 40);
    expect(lines[3]).toBe(` <dim>${"Welcome to Free Pi, ad-supported infer…"}</dim>`);
    expect(lines[3].replace(/<\/?dim>/g, "").length).toBe(40);
  });
});

describe("consent lines at 100 columns", () => {
  const theme = { fg: (c: string, t: string) => `<${c}>${t}</${c}>`, bold: (t: string) => `<b>${t}</b>` };
  test("neither consent line is truncated at width 100", () => {
    const lines = headerLines(theme, "DeepSeek V4 Flash", false, 100);
    const consent = lines.filter((l) => l.includes("you consent") || l.includes("/privacy-policy."));
    expect(consent).toHaveLength(2);
    for (const l of consent) {
      expect(l.includes("…")).toBe(false);
      expect(l.replace(/<\/?dim>/g, "").length).toBeLessThan(100);
    }
  });
});
