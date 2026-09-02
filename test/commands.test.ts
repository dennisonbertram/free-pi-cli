import { describe, expect, test } from "bun:test";
import { CHANGELOG_HIGHLIGHTS } from "../src/changelog";
import { buyCredits, closeOtherSession, runUpdate, showUsage, showWhatsNew } from "../src/commands";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return ((url: URL | string, init?: RequestInit) =>
    Promise.resolve(handler(url.toString(), init))) as unknown as typeof fetch;
}
function notifyCtx() {
  const notes: Array<{ msg: string; type?: string }> = [];
  return {
    ctx: { ui: { notify: (msg: string, type?: "info" | "warning" | "error") => notes.push({ msg, type }) } },
    notes,
  };
}

describe("/close-other-session (closeOtherSession)", () => {
  test("released:true → 'cleared' line, POSTs /session/reset with the Bearer JWT", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const fetchImpl = fakeFetch((url, init) => {
      seen = { url, init };
      return Response.json({ released: true });
    });
    const { ctx, notes } = notifyCtx();
    await closeOtherSession({ baseUrl: "https://api.test", getToken: () => "jwt-abc", fetchImpl }, ctx);
    expect(seen?.url).toBe("https://api.test/session/reset");
    expect(seen?.init?.method).toBe("POST");
    expect((seen?.init?.headers as Record<string, string>)?.authorization).toBe("Bearer jwt-abc");
    expect(notes[0]?.msg).toContain("Cleared your other session");
  });

  test("released:false → 'No other session was running.'", async () => {
    const { ctx, notes } = notifyCtx();
    await closeOtherSession(
      { baseUrl: "https://api.test", getToken: () => "t", fetchImpl: fakeFetch(() => Response.json({ released: false })) },
      ctx,
    );
    expect(notes[0]?.msg).toContain("No other session was running");
  });

  test("non-200 → friendly error, never throws", async () => {
    const { ctx, notes } = notifyCtx();
    await closeOtherSession(
      { baseUrl: "https://api.test", getToken: () => "t", fetchImpl: fakeFetch(() => new Response("boom", { status: 500 })) },
      ctx,
    );
    expect(notes[0]?.type).toBe("error");
    expect(notes[0]?.msg).toContain("Couldn't reset");
  });

  test("network failure → friendly error, never throws", async () => {
    const { ctx, notes } = notifyCtx();
    await closeOtherSession(
      {
        baseUrl: "https://api.test",
        getToken: () => "t",
        fetchImpl: fakeFetch(() => {
          throw new Error("down");
        }),
      },
      ctx,
    );
    expect(notes[0]?.type).toBe("error");
    expect(notes[0]?.msg).toContain("Couldn't reach");
  });
});

describe("/whats-new (showWhatsNew)", () => {
  // Asserted against CHANGELOG_HIGHLIGHTS rather than hardcoded version
  // strings: this test named 0.2.6 and so broke on every release, which
  // teaches people to edit the assertion instead of reading it.
  test("prints the three most recent entries, newest first", () => {
    const { ctx, notes } = notifyCtx();
    showWhatsNew(ctx);
    expect(notes).toHaveLength(1);
    const expected = CHANGELOG_HIGHLIGHTS.slice(0, 3);
    expect(expected.length).toBeGreaterThan(0);
    for (const entry of expected) {
      expect(notes[0]?.msg).toContain(`free-pi ${entry.version}:`);
      for (const highlight of entry.highlights) {
        expect(notes[0]?.msg).toContain(highlight);
      }
    }
  });

  test("stops at three entries even when more exist", () => {
    const { ctx, notes } = notifyCtx();
    showWhatsNew(ctx);
    const shown = (notes[0]?.msg ?? "").split("\n").filter((l) => l.startsWith("free-pi "));
    expect(shown).toHaveLength(Math.min(3, CHANGELOG_HIGHLIGHTS.length));
  });
});

describe("/update (runUpdate)", () => {
  test("npx run → reports already-latest, does not install", async () => {
    const { ctx, notes } = notifyCtx();
    let installed = false;
    await runUpdate(ctx, {
      env: { npm_command: "exec" },
      installLatest: async () => {
        installed = true;
        return { ok: true };
      },
    });
    expect(installed).toBe(false);
    expect(notes[0]?.msg).toContain("always fetches the latest");
  });

  test("global install, success → 'Updated — restart'", async () => {
    const { ctx, notes } = notifyCtx();
    await runUpdate(ctx, { env: {}, installLatest: async () => ({ ok: true }) });
    expect(notes.at(-1)?.msg).toContain("Updated");
    expect(notes.at(-1)?.type).toBe("info");
  });

  test("global install, failure → friendly error with manual command", async () => {
    const { ctx, notes } = notifyCtx();
    await runUpdate(ctx, { env: {}, installLatest: async () => ({ ok: false }) });
    expect(notes.at(-1)?.type).toBe("error");
    expect(notes.at(-1)?.msg).toContain("npm install -g free-pi-cli@latest");
  });
});

describe("/buy-credits (buyCredits)", () => {
  const BUY_URL = "https://api.test/buy/tok123";
  function ctx(): { ctx: { ui: { notify(m: string, t?: string): void } }; notes: Array<{ m: string; t?: string }> } {
    const notes: Array<{ m: string; t?: string }> = [];
    return { ctx: { ui: { notify: (m: string, t?: string) => void notes.push({ m, t }) } }, notes };
  }
  function opts(body: unknown, status = 200) {
    const requests: Array<{ url: string; method?: string }> = [];
    const opened: string[] = [];
    const fetchImpl = (async (input: URL | string, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });
      return status === 200 ? Response.json(body) : new Response("nope", { status });
    }) as unknown as typeof fetch;
    return {
      o: { baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl, openBrowserImpl: (u: string) => void opened.push(u) },
      requests,
      opened,
    };
  }

  test("buy_url present → opens it and notifies with the URL; only a GET /me was made", async () => {
    const { o, requests, opened } = opts({ buy_url: BUY_URL });
    const c = ctx();
    await buyCredits(o, c.ctx);
    expect(opened).toEqual([BUY_URL]);
    expect(c.notes).toHaveLength(1);
    expect(c.notes[0]!.m).toContain(BUY_URL);
    expect(c.notes[0]!.t).toBe("info");
    expect(requests).toEqual([{ url: "https://api.test/me", method: undefined }]);
  });

  test("buy_url absent (old server) → 'not available' notice, nothing opened", async () => {
    const { o, opened } = opts({ user_id: "u1" });
    const c = ctx();
    await buyCredits(o, c.ctx);
    expect(opened).toEqual([]);
    expect(c.notes[0]!.m).toBe("Buying credits is not available on this server yet.");
  });

  test("HTTP 500 and a thrown fetch → friendly error, never throws", async () => {
    const { o } = opts({}, 500);
    const c = ctx();
    await buyCredits(o, c.ctx);
    expect(c.notes[0]!.t).toBe("error");
    const throwing = { baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, openBrowserImpl: () => {} };
    const c2 = ctx();
    await buyCredits(throwing, c2.ctx);
    expect(c2.notes[0]!.m).toContain("offline");
  });
});

describe("/usage (showUsage)", () => {
  const STATS = {
    user_id: "u1", handle: "octocat", tier: "young", cap_usd_today: 2, spent_usd_today: 0.5, remaining_usd_today: 1.5,
    credit_usd: 3.75, credit_credits: 50000, request_count_today: 3, prompt_tokens_today: 120, completion_tokens_today: 60,
    lifetime: { spent_usd: 4.2, prompt_tokens: 900, completion_tokens: 400, request_count: 12 },
  };
  test("notifies the same percentage-only text as the tool, from GET /me/stats", async () => {
    const urls: string[] = [];
    const fetchImpl = fakeFetch((url) => { urls.push(url); return Response.json(STATS); });
    const { ctx, notes } = notifyCtx();
    await showUsage({ baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl }, ctx);
    expect(urls).toEqual(["https://api.test/me/stats"]);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.type).toBe("info");
    expect(notes[0]!.msg.split("\n")).toEqual([
      "tier: young",
      "today: 25% of your free daily allowance used",
      "credit: 50,000 credits remaining",
      "today tokens: 120 prompt / 60 completion",
      "lifetime: 900 prompt / 400 completion tokens",
    ]);
  });
  test("server error → one error notice, never throws", async () => {
    const { ctx, notes } = notifyCtx();
    await showUsage({ baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl: fakeFetch(() => new Response("x", { status: 503 })) }, ctx);
    expect(notes[0]!.type).toBe("error");
    expect(notes[0]!.msg).toContain("503");
  });
});
