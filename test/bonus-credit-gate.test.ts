// #23: the bonus-credit gate. Two layers, same as the rest of the repo:
// decideBonusGate is pure and tested exhaustively, and the `input` handler is
// driven with a fake ctx + fake fetch so every branch (including the ones
// that must NOT fetch or show a dialog) is pinned.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, InputEvent, InputEventResult } from "@earendil-works/pi-coding-agent";
import {
  BONUS_GATE_ALWAYS,
  BONUS_GATE_DECLINED_NOTICE,
  BONUS_GATE_NOT_NOW,
  BONUS_GATE_USE,
  createBonusCreditGateExtension,
  decideBonusGate,
} from "../src/bonus-credit-gate";
import { readSpendBonusCredits } from "../src/cli-config";

function tempConfigPath(spendBonusCredits?: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "free-pi-bonus-gate-"));
  const path = join(dir, "config.json");
  if (spendBonusCredits !== undefined) writeFileSync(path, JSON.stringify({ spendBonusCredits }));
  return path;
}

describe("decideBonusGate — the whole rule, in order", () => {
  test("auto always proceeds", () => {
    expect(decideBonusGate({ mode: "auto", remainingCreditsToday: 0, bonusCredits: 50_000 })).toBe("proceed");
  });

  test("free allowance left -> proceed, even with bonus credits", () => {
    expect(decideBonusGate({ mode: "ask", remainingCreditsToday: 12_400, bonusCredits: 50_000 })).toBe("proceed");
  });

  test("allowance gone and no bonus credits -> proceed (the server's free lane handles it)", () => {
    expect(decideBonusGate({ mode: "ask", remainingCreditsToday: 0, bonusCredits: 0 })).toBe("proceed");
    expect(decideBonusGate({ mode: "ask", remainingCreditsToday: 0, bonusCredits: -1 })).toBe("proceed");
  });

  test("allowance gone with bonus credits -> ask", () => {
    expect(decideBonusGate({ mode: "ask", remainingCreditsToday: 0, bonusCredits: 50_000 })).toBe("ask");
  });
});

// ---- handler harness -------------------------------------------------------

interface Harness {
  run(event: InputEvent): Promise<InputEventResult>;
  notes: Array<{ msg: string; type?: string }>;
  selects: Array<{ title: string; options: string[] }>;
  editor: string[];
  /** One entry per fetch the handler actually made. */
  fetches: string[];
}

function harness(o: {
  configPath: string;
  answer?: string | undefined;
  fetchImpl?: typeof fetch;
  selectThrows?: boolean;
}): Harness {
  let handler: ((event: InputEvent, ctx: ExtensionContext) => Promise<InputEventResult>) | undefined;
  const fetches: string[] = [];
  const inner =
    o.fetchImpl ??
    ((async () => {
      throw new Error("fetch should not have been called");
    }) as unknown as typeof fetch);
  const fetchImpl = ((input: URL | string, init?: RequestInit) => {
    fetches.push(String(input));
    return inner(input, init);
  }) as unknown as typeof fetch;
  const ext = createBonusCreditGateExtension({
    baseUrl: "https://api.test",
    getToken: () => "jwt",
    configPath: o.configPath,
    fetchImpl,
  });
  // InlineExtension is a union; this test knows which arm it built.
  const inline = ext as { name: string; factory: (pi: ExtensionAPI) => void };
  expect(inline.name).toBe("free-pi-bonus-credits");
  // The extension only touches pi.on("input"); everything else is unused here.
  inline.factory({ on: (_event: string, h: never) => h && (handler = h) } as unknown as ExtensionAPI);

  const notes: Array<{ msg: string; type?: string }> = [];
  const selects: Array<{ title: string; options: string[] }> = [];
  const editor: string[] = [];
  const urls: string[] = [];
  const ctx = {
    ui: {
      select: async (title: string, options: string[]) => {
        if (o.selectThrows) throw new Error("dialog exploded");
        selects.push({ title, options });
        return o.answer;
      },
      notify: (msg: string, type?: "info" | "warning" | "error") => notes.push({ msg, type }),
      setEditorText: (text: string) => editor.push(text),
    },
  } as unknown as ExtensionContext;

  return {
    async run(event) {
      if (!handler) throw new Error("input handler was not registered");
      return handler(event, ctx);
    },
    notes,
    selects,
    editor,
    fetches,
  };
}

const interactive = (text = "refactor the parser"): InputEvent => ({ type: "input", text, source: "interactive" });

const me = (body: Record<string, unknown>, status = 200): typeof fetch =>
  (async () => (status === 200 ? Response.json(body) : new Response("nope", { status }))) as unknown as typeof fetch;

const ME_WITH_BONUS = { remaining_credits_today: 0, bonus_credits: 50_000 };
const ME_WITH_ALLOWANCE = { remaining_credits_today: 12_400, bonus_credits: 50_000 };
const ME_NO_BONUS = { remaining_credits_today: 0, bonus_credits: 0 };

describe("free-pi-bonus-credits input handler", () => {
  test("auto mode -> continue with no fetch and no dialog", async () => {
    const h = harness({ configPath: tempConfigPath(true), fetchImpl: me(ME_WITH_BONUS) });
    const result = await h.run(interactive());
    expect(result).toEqual({ action: "continue" });
    expect(h.selects).toHaveLength(0);
    expect(h.fetches).toHaveLength(0);
  });

  test("allowance left -> continue, no dialog", async () => {
    const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_WITH_ALLOWANCE) });
    expect(await h.run(interactive())).toEqual({ action: "continue" });
    expect(h.selects).toHaveLength(0);
  });

  test("allowance gone, no bonus credits -> continue, no dialog", async () => {
    const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_NO_BONUS) });
    expect(await h.run(interactive())).toEqual({ action: "continue" });
    expect(h.selects).toHaveLength(0);
  });

  test("allowance gone with bonus credits -> dialog with the three options in order and the balance in the title", async () => {
    const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_WITH_BONUS), answer: BONUS_GATE_USE });
    await h.run(interactive());
    expect(h.selects).toHaveLength(1);
    expect(h.selects[0]!.options).toEqual([BONUS_GATE_USE, BONUS_GATE_NOT_NOW, BONUS_GATE_ALWAYS]);
    expect(h.selects[0]!.title).toContain("Your free allowance is used up");
    expect(h.selects[0]!.title).toContain("50,000 bonus credits left");
  });

  test("\"Use bonus credits\" -> continue", async () => {
    const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_WITH_BONUS), answer: BONUS_GATE_USE });
    expect(await h.run(interactive())).toEqual({ action: "continue" });
    expect(h.notes).toHaveLength(0);
    expect(h.editor).toHaveLength(0);
  });

  test("\"Not now\" -> handled: draft restored, notified, nothing sent", async () => {
    const configPath = tempConfigPath();
    const h = harness({ configPath, fetchImpl: me(ME_WITH_BONUS), answer: BONUS_GATE_NOT_NOW });
    const result = await h.run(interactive("keep this draft"));
    expect(result).toEqual({ action: "handled" });
    expect(h.editor).toEqual(["keep this draft"]);
    expect(h.notes).toEqual([{ msg: BONUS_GATE_DECLINED_NOTICE, type: "info" }]);
    // Declining never turns the setting on.
    expect(readSpendBonusCredits(configPath)).toBe(false);
  });

  test("dismissed dialog (undefined) -> handled, same as \"Not now\"", async () => {
    const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_WITH_BONUS), answer: undefined });
    const result = await h.run(interactive());
    expect(result).toEqual({ action: "handled" });
    expect(h.editor).toHaveLength(1);
    expect(h.notes[0]!.msg).toBe(BONUS_GATE_DECLINED_NOTICE);
  });

  test("\"Always...\" -> persists the setting and continues", async () => {
    const configPath = tempConfigPath();
    const h = harness({ configPath, fetchImpl: me(ME_WITH_BONUS), answer: BONUS_GATE_ALWAYS });
    const result = await h.run(interactive());
    expect(result).toEqual({ action: "continue" });
    expect(readSpendBonusCredits(configPath)).toBe(true);
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.msg).toContain("automatically");
    expect(h.notes[0]!.msg).toContain("/spend-bonus-credits");
  });

  test("\"Always...\" with an unwritable config -> says it could not save, still continues", async () => {
    // A file where the parent directory should be: mkdirSync cannot create it.
    const blocker = tempConfigPath();
    writeFileSync(blocker, "");
    const h = harness({ configPath: join(blocker, "config.json"), fetchImpl: me(ME_WITH_BONUS), answer: BONUS_GATE_ALWAYS });
    expect(await h.run(interactive())).toEqual({ action: "continue" });
    expect(h.notes).toHaveLength(1);
    expect(h.notes[0]!.type).toBe("error");
    expect(h.notes[0]!.msg).toContain("Couldn't save");
  });

  test("fetch throws -> fail open", async () => {
    const h = harness({
      configPath: tempConfigPath(),
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    expect(await h.run(interactive())).toEqual({ action: "continue" });
    expect(h.selects).toHaveLength(0);
  });

  test("HTTP 500 -> fail open", async () => {
    const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_WITH_BONUS, 500) });
    expect(await h.run(interactive())).toEqual({ action: "continue" });
    expect(h.selects).toHaveLength(0);
  });

  test("missing fields (old server) -> fail open; non-number fields too", async () => {
    const missing = harness({ configPath: tempConfigPath(), fetchImpl: me({ user_id: "u1" }) });
    expect(await missing.run(interactive())).toEqual({ action: "continue" });
    expect(missing.selects).toHaveLength(0);

    const wrongType = harness({
      configPath: tempConfigPath(),
      fetchImpl: me({ remaining_credits_today: 0, bonus_credits: "50000" }),
    });
    expect(await wrongType.run(interactive())).toEqual({ action: "continue" });
    expect(wrongType.selects).toHaveLength(0);
  });

  test("source \"extension\" (and \"rpc\") -> skipped: no fetch, no dialog", async () => {
    for (const source of ["extension", "rpc"] as const) {
      const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_WITH_BONUS), answer: BONUS_GATE_USE });
      expect(await h.run({ type: "input", text: "x", source })).toEqual({ action: "continue" });
      expect(h.selects).toHaveLength(0);
      expect(h.fetches).toHaveLength(0);
    }
  });

  test("a throwing dialog -> fail open rather than block the turn", async () => {
    const h = harness({ configPath: tempConfigPath(), fetchImpl: me(ME_WITH_BONUS), selectThrows: true });
    expect(await h.run(interactive())).toEqual({ action: "continue" });
  });
});
