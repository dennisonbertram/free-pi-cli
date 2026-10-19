import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GRAVITY_PIXEL_ID, startGravityPixel } from "../src/gravity-pixel";
import { saveJwt } from "../src/credentials";
import { CONSENT_VERSION } from "../src/consent";
import { run, type RunDeps } from "../src/run";

const jwtFor = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.s`;
const tick = () => new Promise((r) => setTimeout(r, 30));

function fakeSdk(opts: { startHangs?: boolean; startThrows?: boolean } = {}) {
  const seen: { pixelOpts?: any; ctxArgs?: any } = {};
  const sdk = {
    gravityPixel: (o: any) => {
      seen.pixelOpts = o;
      return {
        start: async () => {
          if (opts.startThrows) throw new Error("boom");
          if (opts.startHangs) await new Promise(() => {});
        },
        getSessionId: () => "gr_sess_1",
        getVisitorId: () => "gruid_1",
        getClickId: () => undefined,
        getGraid: () => undefined,
      };
    },
    gravityContext: (a: any) => {
      seen.ctxArgs = a;
      return { sessionId: a.sessionId, user: { ...a.user, id: a.user.userId } };
    },
  };
  return { sdk: sdk as any, seen };
}

describe("startGravityPixel", () => {
  test("starts with our pixel id and storage dir; context carries sha256(user id) + pixel ids, base64url", async () => {
    const { sdk, seen } = fakeSdk();
    const get = startGravityPixel(jwtFor("user-1"), "/x/gravity", {}, async () => sdk)!;
    await tick();
    expect(seen.pixelOpts.pixelId).toBe(GRAVITY_PIXEL_ID);
    expect(seen.pixelOpts.storageDir).toBe("/x/gravity");
    const decoded = JSON.parse(Buffer.from(get()!, "base64url").toString());
    expect(decoded.sessionId).toBe("gr_sess_1");
    expect(seen.ctxArgs.user.userId).toBe(createHash("sha256").update("user-1").digest("hex"));
    expect(seen.ctxArgs.user.gruid).toBe("gruid_1");
  });

  test("kill switch: nothing loaded, no getter", () => {
    let loaded = false;
    const get = startGravityPixel(jwtFor("u"), "/x", { FREEPI_NO_GRAVITY_PIXEL: "1" }, async () => {
      loaded = true;
      return fakeSdk().sdk;
    });
    expect(get).toBeUndefined();
    expect(loaded).toBe(false);
  });

  test("a hanging start() does not block; context is available from the session id", async () => {
    const { sdk } = fakeSdk({ startHangs: true });
    const get = startGravityPixel(jwtFor("u"), "/x", {}, async () => sdk)!;
    await tick();
    expect(get()).toBeString();
  });

  test("load or start failure: no throw, getter yields undefined", async () => {
    const a = startGravityPixel(jwtFor("u"), "/x", {}, async () => { throw new Error("no sdk"); })!;
    const b = startGravityPixel(jwtFor("u"), "/x", {}, async () => fakeSdk({ startThrows: true }).sdk)!;
    await tick();
    expect(a()).toBeUndefined();
    expect(b()).toBeUndefined();
  });

  test("the SDK's SIGINT/SIGTERM exit handlers are removed, its exit listener and others are kept", async () => {
    const before = { int: process.listeners("SIGINT").length, term: process.listeners("SIGTERM").length, exit: process.listeners("exit").length };
    const own = () => {};
    const { sdk } = fakeSdk();
    const base = sdk.gravityPixel;
    sdk.gravityPixel = (o: any) => {
      const p = base(o);
      p.start = async () => {
        await tick();
        const self = { shutdownSync() {} };
        process.on("exit", () => {});
        process.on("SIGINT", () => { self.shutdownSync(); process.exit(0); });
        process.on("SIGTERM", () => { self.shutdownSync(); process.exit(0); });
        process.on("SIGINT", own); // an unrelated listener added meanwhile stays
      };
      return p;
    };
    startGravityPixel(jwtFor("u"), "/x", {}, async () => sdk);
    await tick();
    await tick();
    expect(process.listeners("SIGINT").length).toBe(before.int + 1);
    expect(process.listeners("SIGINT")).toContain(own);
    expect(process.listeners("SIGTERM").length).toBe(before.term);
    expect(process.listeners("exit").length).toBe(before.exit + 1);
    process.removeListener("SIGINT", own);
    process.listeners("exit").slice(before.exit).forEach((l) => process.removeListener("exit", l as () => void));
  });

  test("oversize context is dropped", async () => {
    const { sdk } = fakeSdk();
    sdk.gravityContext = () => ({ big: "x".repeat(9000) });
    const get = startGravityPixel(jwtFor("u"), "/x", {}, async () => sdk)!;
    await tick();
    expect(get()).toBeUndefined();
  });

  test("a JWT without a sub does not start", () => {
    expect(startGravityPixel("garbage", "/x", {}, async () => fakeSdk().sdk)).toBeUndefined();
  });
});

describe("run(): pixel starts only after consent for the current version", () => {
  async function runWith(meConsent: string | null | undefined, opts: { accept?: boolean; pixelThrows?: boolean } = {}) {
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const p = new URL(req.url).pathname;
        if (p === "/me") return Response.json({ user_id: "u1", handle: "h", remaining_usd_today: 1, ...(meConsent !== undefined ? { consent_version: meConsent } : {}) });
        return Response.json({ ok: true });
      },
    });
    const dir = mkdtempSync(join(tmpdir(), "gp-"));
    const credentialsPath = join(dir, "credentials.json");
    await saveJwt(credentialsPath, jwtFor("u1"));
    let started = 0;
    let launchedCtx: (() => string | undefined) | undefined;
    const deps: RunDeps = {
      baseUrl: `http://localhost:${server.port}`,
      agentDir: dir,
      credentialsPath,
      promptConsent: async () => opts.accept ?? true,
      openBrowser: () => {},
      sleep: async () => {},
      launchPi: async (o) => {
        launchedCtx = o.getGravityContext;
      },
      log: () => {},
      checkClientVersion: async () => ({ action: "ok" }),
      maybeSelfUpdate: async () => "blocked",
      startGravityPixel: () => {
        started++;
        if (opts.pixelThrows) throw new Error("boom");
        return () => "ctx";
      },
    };
    const code = await run(deps, ["node", "free-pi"]);
    server.stop(true);
    return { code, started, launchedCtx };
  }

  test("server consent is current: pixel starts and the getter reaches launchPi", async () => {
    const r = await runWith(CONSENT_VERSION);
    expect(r.started).toBe(1);
    expect(r.launchedCtx?.()).toBe("ctx");
  });

  test("older consent, accepted at the re-prompt: pixel starts", async () => {
    expect((await runWith("3")).started).toBe(1);
  });

  test("older consent, declined: exits before any pixel", async () => {
    const r = await runWith("3", { accept: false });
    expect(r.code).toBe(1);
    expect(r.started).toBe(0);
  });

  test("never-recorded or unreported consent: no pixel", async () => {
    expect((await runWith(undefined)).started).toBe(0);
  });

  test("a pixel that throws does not break startup", async () => {
    const r = await runWith(CONSENT_VERSION, { pixelThrows: true });
    expect(r.code).toBe(0);
    expect(r.launchedCtx).toBeUndefined();
  });
});
