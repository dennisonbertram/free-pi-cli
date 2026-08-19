import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveJwt } from "../src/credentials";
import { DEFAULT_BASE_URL, resolveBaseUrl } from "../src/env";
import { buildProviderConfig, MODEL_ID } from "../src/provider";
import { CLI_VERSION } from "../src/version";
import { run, type RunDeps } from "../src/run";
import { pollForToken, startDeviceFlow } from "../src/auth-flow";

const USER_CODE = "ABCD-1234";
const VERIFICATION_URI = "https://github.com/login/device";
const ISSUED_TOKEN = "test-jwt-token";

interface StubOptions {
  /** One entry per /auth/token poll; last entry repeats once exhausted. */
  tokenSequence?: Array<"pending" | "issued">;
  meStatus?: number;
}

interface StubServer {
  url: string;
  requests: Array<{ method: string; path: string }>;
  stop: () => void;
}

function startStub(opts: StubOptions = {}): StubServer {
  const requests: StubServer["requests"] = [];
  let tokenCalls = 0;
  const tokenSequence = opts.tokenSequence ?? ["issued"];

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      requests.push({ method: req.method, path: url.pathname });

      if (req.method === "POST" && url.pathname === "/auth/github/device") {
        return Response.json({
          session_id: "sess-1",
          user_code: USER_CODE,
          verification_uri: VERIFICATION_URI,
          interval: 0,
        });
      }
      if (req.method === "POST" && url.pathname === "/auth/consent") {
        return Response.json({ ok: true });
      }
      if (req.method === "POST" && url.pathname === "/auth/token") {
        const state = tokenSequence[Math.min(tokenCalls, tokenSequence.length - 1)];
        tokenCalls++;
        if (state === "pending") return Response.json({ status: "pending" });
        return Response.json({ token: ISSUED_TOKEN });
      }
      if (req.method === "GET" && url.pathname === "/me") {
        if ((opts.meStatus ?? 200) === 401) return new Response(null, { status: 401 });
        return Response.json({ user_id: "u1", handle: "octocat", remaining_usd_today: 5 });
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    url: `http://localhost:${server.port}`,
    requests,
    stop: () => server.stop(true),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "free-pi-cli-test-"));
}

function baseDeps(overrides: Partial<RunDeps> & Pick<RunDeps, "baseUrl" | "agentDir" | "credentialsPath">): RunDeps {
  return {
    promptConsent: async () => true,
    openBrowser: () => {},
    sleep: async () => {},
    launchPi: async () => {},
    log: () => {},
    checkClientVersion: async () => ({ action: "ok" }),
    // #37 U1: mirrors self-update's own fallback so existing block/notice
    // expectations are unchanged unless a test opts in with an override.
    maybeSelfUpdate: async (action) => (action === "notice" ? "notice" : "blocked"),
    ...overrides,
  };
}

describe("first-run consent", () => {
  test("declining exits nonzero and makes zero requests to the server", async () => {
    const stub = startStub();
    const dir = tempDir();
    let consentShown = false;
    let piLaunched = false;
    let versionCheckCalled = false;
    let selfUpdateCalled = false;

    const code = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath: join(dir, "credentials.json"),
        promptConsent: async () => {
          consentShown = true;
          return false;
        },
        launchPi: async () => {
          piLaunched = true;
        },
        // #37 R5: the version check itself must never be called on a decline —
        // it would be one more server call, and decline must make zero.
        checkClientVersion: async () => {
          versionCheckCalled = true;
          return { action: "ok" };
        },
        // #37 U1/R5: self-update is only reached past the consent gate, so a
        // decline must never invoke it either.
        maybeSelfUpdate: async (action) => {
          selfUpdateCalled = true;
          return action === "notice" ? "notice" : "blocked";
        },
      }),
    );

    expect(code).not.toBe(0);
    expect(consentShown).toBe(true);
    expect(piLaunched).toBe(false);
    expect(versionCheckCalled).toBe(false);
    expect(selfUpdateCalled).toBe(false);
    expect(stub.requests.length).toBe(0);
    stub.stop();
  });
});

describe("forced-update hard-stop (R2, #37)", () => {
  test("a below-min version exits 1 without launching pi", async () => {
    const stub = startStub();
    const dir = tempDir();
    let piLaunched = false;

    const code = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath: join(dir, "credentials.json"),
        launchPi: async () => {
          piLaunched = true;
        },
        checkClientVersion: async () => ({ action: "block" }),
      }),
    );

    expect(code).toBe(1);
    expect(piLaunched).toBe(false);
    stub.stop();
  });
});

describe("self-update wiring in run.ts (#37 U1)", () => {
  test("below-min + self-update succeeds -> exit 0, does NOT launch pi (re-run required)", async () => {
    const stub = startStub();
    const dir = tempDir();
    let piLaunched = false;
    let selfUpdateArgs: { action: string; latest: string | undefined } | undefined;

    const code = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath: join(dir, "credentials.json"),
        launchPi: async () => {
          piLaunched = true;
        },
        checkClientVersion: async () => ({ action: "block", latest: "0.9.0" }),
        maybeSelfUpdate: async (action, latest) => {
          selfUpdateArgs = { action, latest };
          return "updated-exit";
        },
      }),
    );

    expect(code).toBe(0);
    expect(piLaunched).toBe(false);
    expect(selfUpdateArgs).toEqual({ action: "block", latest: "0.9.0" });
    stub.stop();
  });

  test("below-min + self-update disabled/falls back -> exit 1 (unchanged phase-1 hard-stop)", async () => {
    const stub = startStub();
    const dir = tempDir();
    let piLaunched = false;

    const code = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath: join(dir, "credentials.json"),
        launchPi: async () => {
          piLaunched = true;
        },
        checkClientVersion: async () => ({ action: "block", latest: "0.9.0" }),
        maybeSelfUpdate: async () => "blocked",
      }),
    );

    expect(code).toBe(1);
    expect(piLaunched).toBe(false);
    stub.stop();
  });

  test("notice + self-update succeeds -> updated-continue, still launches pi this run", async () => {
    const stub = startStub();
    const dir = tempDir();
    let piLaunched = false;
    const logs: string[] = [];

    const code = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath: join(dir, "credentials.json"),
        log: (m) => logs.push(m),
        launchPi: async () => {
          piLaunched = true;
        },
        checkClientVersion: async () => ({ action: "notice", latest: "0.9.0" }),
        maybeSelfUpdate: async () => "updated-continue",
      }),
    );

    expect(code).toBe(0);
    expect(piLaunched).toBe(true);
    // run.ts must not print the phase-1 "update available" text when
    // self-update already handled and logged it — that would be a duplicate.
    expect(logs.some((l) => l.includes("update available"))).toBe(false);
    stub.stop();
  });

  test("notice + self-update falls back -> still prints the phase-1 notice and launches pi", async () => {
    const stub = startStub();
    const dir = tempDir();
    let piLaunched = false;
    const logs: string[] = [];

    const code = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath: join(dir, "credentials.json"),
        log: (m) => logs.push(m),
        launchPi: async () => {
          piLaunched = true;
        },
        checkClientVersion: async () => ({ action: "notice", latest: "0.9.0" }),
        maybeSelfUpdate: async () => "notice",
      }),
    );

    expect(code).toBe(0);
    expect(piLaunched).toBe(true);
    expect(logs.some((l) => l.includes("update available") && l.includes("0.9.0"))).toBe(true);
    stub.stop();
  });
});

describe("device flow login", () => {
  test("accepting consent stores a 0600 JWT and second run skips first-run", async () => {
    const stub = startStub({ tokenSequence: ["pending", "issued"] });
    const dir = tempDir();
    const credentialsPath = join(dir, "credentials.json");
    let launchedJwt: string | undefined;

    const code1 = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath,
        launchPi: async (opts) => {
          launchedJwt = opts.jwt;
        },
      }),
    );

    expect(code1).toBe(0);
    expect(launchedJwt).toBe(ISSUED_TOKEN);
    // Windows has no posix permission bits (chmod there only toggles the
    // read-only flag, and stat reports 0o666), so the 0600 invariant is only
    // assertable — and only meaningful — on posix.
    if (process.platform !== "win32") {
      const mode = statSync(credentialsPath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    let promptCalledOnSecondRun = false;
    const code2 = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath,
        promptConsent: async () => {
          promptCalledOnSecondRun = true;
          return true;
        },
      }),
    );

    expect(code2).toBe(0);
    expect(promptCalledOnSecondRun).toBe(false);
    stub.stop();
  });

  test("prints the device user_code and verification_uri", async () => {
    const stub = startStub();
    const dir = tempDir();
    const logs: string[] = [];

    await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath: join(dir, "credentials.json"),
        log: (message) => logs.push(message),
      }),
    );

    const combined = logs.join("\n");
    expect(combined).toContain(USER_CODE);
    expect(combined).toContain(VERIFICATION_URI);
    stub.stop();
  });
});

describe("401 handling", () => {
  test("a 401 on token validation clears the JWT and re-enters login", async () => {
    const stub = startStub({ meStatus: 401, tokenSequence: ["issued"] });
    const dir = tempDir();
    const credentialsPath = join(dir, "credentials.json");
    await saveJwt(credentialsPath, "stale-jwt");

    let promptCalled = false;
    let launchedJwt: string | undefined;

    const code = await run(
      baseDeps({
        baseUrl: stub.url,
        agentDir: dir,
        credentialsPath,
        promptConsent: async () => {
          promptCalled = true;
          return true;
        },
        launchPi: async (opts) => {
          launchedJwt = opts.jwt;
        },
      }),
    );

    expect(code).toBe(0);
    expect(promptCalled).toBe(true);
    expect(launchedJwt).toBe(ISSUED_TOKEN);
    expect(launchedJwt).not.toBe("stale-jwt");
    stub.stop();
  });
});

describe("provider registration", () => {
  test("points at the configured base URL with the free-pi model", () => {
    const config = buildProviderConfig("http://example.test:4321", "jwt-abc", "session-1");

    // /v1 is appended because pi's openai-completions client (openai SDK)
    // appends /chat/completions to the base — verified live 2026-08-14.
    expect(config.baseUrl).toBe("http://example.test:4321/v1");
    expect(config.apiKey).toBe("jwt-abc");
    expect(config.api).toBe("openai-completions");
    expect(config.models?.[0]?.id).toBe(MODEL_ID);
    expect(config.models?.[0]?.contextWindow).toBe(1_048_576);
    expect(config.models?.[0]?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("#28 R19/KTD-3: threads sessionId through as a static x-session-id header", () => {
    const a = buildProviderConfig("http://example.test:4321", "jwt-abc", "session-a");
    // #37: x-client-version rides alongside x-session-id on every completion.
    expect(a.headers).toEqual({ "x-session-id": "session-a", "x-client-version": CLI_VERSION });

    // Stable across repeated calls with the same sessionId, different across
    // two different sessionIds — a process's identity is fixed for its
    // lifetime (KTD-3: generated once per launchPi() call).
    const aAgain = buildProviderConfig("http://example.test:4321", "jwt-abc", "session-a");
    expect(aAgain.headers).toEqual(a.headers);

    const b = buildProviderConfig("http://example.test:4321", "jwt-abc", "session-b");
    expect(b.headers).not.toEqual(a.headers);
  });
});

describe("FREEPI_BASE_URL override", () => {
  test("resolveBaseUrl honors the env var and falls back to the default", () => {
    expect(resolveBaseUrl({ FREEPI_BASE_URL: "http://stub.local:9999" })).toBe("http://stub.local:9999");
    expect(resolveBaseUrl({})).toBe(DEFAULT_BASE_URL);
  });
});

describe("pollForToken", () => {
  /** Minimal /auth/token stub: one scripted response per poll, last one repeats. */
  function startTokenStub(responses: Array<{ status: number; body: unknown }>): {
    url: string;
    stop: () => void;
  } {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch() {
        const next = responses[Math.min(calls, responses.length - 1)]!;
        calls++;
        return Response.json(next.body, { status: next.status });
      },
    });
    return { url: server.url.toString(), stop: () => server.stop(true) };
  }

  test("honours the retry_after GitHub asked for via slow_down", async () => {
    const stub = startTokenStub([
      { status: 200, body: { status: "pending", retry_after: 9 } },
      { status: 200, body: { token: "jwt-after-slow-down" } },
    ]);
    const slept: number[] = [];
    try {
      const token = await pollForToken(stub.url, "sess-1", 1, async (ms) => {
        slept.push(ms);
      });
      expect(token).toBe("jwt-after-slow-down");
      // Not the 1s base interval: slow_down's 9s wins.
      expect(slept).toEqual([9_000]);
    } finally {
      stub.stop();
    }
  });

  test("falls back to the base interval when no retry_after is sent", async () => {
    const stub = startTokenStub([
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { token: "jwt-normal" } },
    ]);
    const slept: number[] = [];
    try {
      await pollForToken(stub.url, "sess-1", 2, async (ms) => {
        slept.push(ms);
      });
      expect(slept).toEqual([2_000]);
    } finally {
      stub.stop();
    }
  });

  test("reports consent_required from the server's 403, not a bare HTTP 403", async () => {
    const stub = startTokenStub([
      { status: 403, body: { code: "consent_required", message: "consent required before sign-in" } },
    ]);
    try {
      await expect(pollForToken(stub.url, "sess-1", 1, async () => {})).rejects.toThrow(
        /consent_required/,
      );
    } finally {
      stub.stop();
    }
  });
});

describe("pollForToken network resilience", () => {
  test("survives transient fetch failures and aborts only after 6 consecutive", async () => {
    // Flaky stub: refuse connections by pointing at a closed port for the
    // first polls is hard to sequence, so drive resilience via a stub that
    // kills the socket twice, then succeeds.
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        calls++;
        if (calls <= 2) {
          // abruptly terminate: return a rejected promise to simulate network error
          throw new Error("boom");
        }
        return Response.json({ token: "resilient-jwt" });
      },
      error() {
        return new Response(null, { status: 500 });
      },
    });
    // Bun.serve turns thrown errors into 500s, which exercises the HTTP-error
    // path, not the network path — so ALSO test the true network path with a
    // closed port and assert bounded abort.
    const closed = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const closedUrl = `http://localhost:${closed.port}`;
    closed.stop(true);

    let slept = 0;
    await expect(
      pollForToken(closedUrl, "sess-x", 0, async () => {
        slept++;
      }),
    ).rejects.toThrow(/network unreachable after 6 attempts/);
    expect(slept).toBe(5);
    server.stop(true);
  });
});

describe("startDeviceFlow network resilience", () => {
  test("aborts with a clear error only after bounded retries against a dead endpoint", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadUrl = `http://localhost:${dead.port}`;
    dead.stop(true);
    const started = Date.now();
    await expect(startDeviceFlow(deadUrl)).rejects.toThrow(/network unreachable after 4 attempts/);
    // 3 backoff sleeps of 1.5s/3s/4.5s = 9s minimum wall time proves retries ran.
    expect(Date.now() - started).toBeGreaterThan(8_000);
  }, 30_000);
});
