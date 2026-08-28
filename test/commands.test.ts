import { describe, expect, test } from "bun:test";
import { closeOtherSession, runUpdate, showWhatsNew } from "../src/commands";

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
  test("prints recent changelog highlights", () => {
    const { ctx, notes } = notifyCtx();
    showWhatsNew(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]?.msg).toContain("free-pi 0.2.6");
    expect(notes[0]?.msg).toContain("/close-other-session");
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
