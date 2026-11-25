// Dedicated auth-flow coverage. firstrun.test.ts already proves the flow
// end-to-end plus slow_down pacing, the 403 consent_required branch, and
// bounded network aborts — this file covers the branches that had none:
// submitConsent (entirely untested), startDeviceFlow's HTTP-error and parse
// paths, the retry-is-NETWORK-only semantic, pollForToken's 200-body
// consent_required twin, the non-JSON-403 fallthrough, the 5s pacing floor
// on network failures, the consecutive-failure counter RESET, and checkToken.
import { describe, expect, test } from "bun:test";
import { checkToken, pollForToken, startDeviceFlow, submitConsent, UnauthorizedError } from "../src/auth-flow";

interface Scripted {
  status: number;
  body?: unknown;
  /** Raw (non-JSON) response body — exercises the res.json() failure paths. */
  raw?: string;
}

interface RecordedRequest {
  method: string;
  path: string;
  contentType: string | null;
  authorization: string | null;
  body: unknown;
}

/** One scripted response per request, last entry repeats; records everything. */
function startScriptedStub(responses: Scripted[]): {
  url: string;
  requests: RecordedRequest[];
  stop: () => void;
} {
  const requests: RecordedRequest[] = [];
  let calls = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push({
        method: req.method,
        path: url.pathname,
        contentType: req.headers.get("content-type"),
        authorization: req.headers.get("authorization"),
        body: req.method === "POST" ? await req.json().catch(() => undefined) : undefined,
      });
      const next = responses[Math.min(calls, responses.length - 1)]!;
      calls++;
      if (next.raw !== undefined) return new Response(next.raw, { status: next.status });
      return Response.json(next.body ?? {}, { status: next.status });
    },
  });
  return { url: `http://localhost:${server.port}`, requests, stop: () => server.stop(true) };
}

/**
 * A raw TCP listener that stays bound for its entire lifetime and flips, on
 * cue, between refusing connections and answering with a scripted JSON body.
 * "Refuse" closes the socket before any HTTP bytes, so fetch rejects with a
 * network-class error — the same failure pollForToken's catch handles for
 * ECONNREFUSED. This replaces the previous grab-port/release/rebind dance
 * (and the closed-port trick in the pacing tests), where another process
 * could win the freed port during the test — the one flake candidate
 * flagged in the #4 review. Here the port is owned start to finish.
 */
function startFlakyServer(): {
  url: string;
  refuse: () => void;
  respond: (body: unknown) => void;
  stop: () => void;
} {
  let mode: { kind: "refuse" } | { kind: "respond"; body: unknown } = { kind: "refuse" };
  const answer = (socket: { write: (data: string) => number; end: () => void }) => {
    if (mode.kind === "refuse") {
      socket.end();
      return;
    }
    const body = JSON.stringify(mode.body);
    socket.write(
      `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
    );
    socket.end();
  };
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      // Refusals happen at open (before the request is even sent); real
      // answers wait for the request bytes so the client is mid-read.
      open(socket) {
        if (mode.kind === "refuse") socket.end();
      },
      data(socket) {
        answer(socket);
      },
    },
  });
  return {
    url: `http://127.0.0.1:${listener.port}`,
    refuse: () => {
      mode = { kind: "refuse" };
    },
    respond: (body: unknown) => {
      mode = { kind: "respond", body };
    },
    stop: () => listener.stop(true),
  };
}

const DEVICE_BODY = {
  session_id: "sess-1",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  interval: 5,
};

describe("startDeviceFlow", () => {
  test("posts JSON to /auth/github/device and returns the parsed device response", async () => {
    const stub = startScriptedStub([{ status: 200, body: DEVICE_BODY }]);
    try {
      const device = await startDeviceFlow(stub.url);
      expect(device).toEqual(DEVICE_BODY);
      expect(stub.requests).toEqual([
        {
          method: "POST",
          path: "/auth/github/device",
          contentType: "application/json",
          authorization: null,
          body: {},
        },
      ]);
    } finally {
      stub.stop();
    }
  });

  test("HTTP 500 -> throws with the status after exactly ONE request (retry is network-only; HTTP responses are returned as-is)", async () => {
    const stub = startScriptedStub([{ status: 500 }]);
    try {
      await expect(startDeviceFlow(stub.url)).rejects.toThrow("device flow start failed: HTTP 500");
      // The whole point of postJsonRetry's contract: a server that ANSWERED
      // must not be hammered three more times just because it answered 5xx.
      expect(stub.requests.length).toBe(1);
    } finally {
      stub.stop();
    }
  });

  test("a 200 with a malformed body -> rejects at schema parse instead of returning a half-usable device object", async () => {
    const stub = startScriptedStub([{ status: 200, body: { session_id: "sess-1" } }]);
    try {
      await expect(startDeviceFlow(stub.url)).rejects.toThrow();
    } finally {
      stub.stop();
    }
  });
});

describe("submitConsent", () => {
  test("posts session_id + consent_version verbatim and resolves on ok", async () => {
    const stub = startScriptedStub([{ status: 200, body: { ok: true } }]);
    try {
      await submitConsent(stub.url, "sess-1", "1");
      expect(stub.requests[0]?.path).toBe("/auth/consent");
      expect(stub.requests[0]?.body).toEqual({ session_id: "sess-1", consent_version: "1" });
    } finally {
      stub.stop();
    }
  });

  test("HTTP 500 -> throws with the status after exactly one request", async () => {
    const stub = startScriptedStub([{ status: 500 }]);
    try {
      await expect(submitConsent(stub.url, "sess-1", "1")).rejects.toThrow(
        "consent submission failed: HTTP 500",
      );
      expect(stub.requests.length).toBe(1);
    } finally {
      stub.stop();
    }
  });
});

describe("pollForToken — response branches", () => {
  test("posts the session_id on every poll", async () => {
    const stub = startScriptedStub([
      { status: 200, body: { status: "pending" } },
      { status: 200, body: { token: "jwt-1" } },
    ]);
    try {
      await pollForToken(stub.url, "sess-42", 0, async () => {});
      expect(stub.requests.map((r) => r.body)).toEqual([{ session_id: "sess-42" }, { session_id: "sess-42" }]);
    } finally {
      stub.stop();
    }
  });

  test("a 200 body carrying code=consent_required -> the actionable error (twin of firstrun's 403 test)", async () => {
    const stub = startScriptedStub([
      { status: 200, body: { code: "consent_required", message: "consent required" } },
    ]);
    try {
      await expect(pollForToken(stub.url, "sess-1", 0, async () => {})).rejects.toThrow(/consent_required/);
    } finally {
      stub.stop();
    }
  });

  test("403 with a non-JSON body -> generic HTTP 403 (the res.json().catch fallthrough, not a crash)", async () => {
    const stub = startScriptedStub([{ status: 403, raw: "<html>forbidden</html>" }]);
    try {
      await expect(pollForToken(stub.url, "sess-1", 0, async () => {})).rejects.toThrow(
        "token poll failed: HTTP 403",
      );
    } finally {
      stub.stop();
    }
  });

  test("403 with JSON but a different code -> generic HTTP 403, not the consent message", async () => {
    const stub = startScriptedStub([{ status: 403, body: { code: "banned" } }]);
    try {
      await expect(pollForToken(stub.url, "sess-1", 0, async () => {})).rejects.toThrow(
        "token poll failed: HTTP 403",
      );
    } finally {
      stub.stop();
    }
  });

  test("any other non-ok status -> throws with that status", async () => {
    const stub = startScriptedStub([{ status: 500 }]);
    try {
      await expect(pollForToken(stub.url, "sess-1", 0, async () => {})).rejects.toThrow(
        "token poll failed: HTTP 500",
      );
    } finally {
      stub.stop();
    }
  });
});

describe("pollForToken — network failure pacing and counter reset", () => {
  test("network-failure sleeps are floored at 5s even when the poll interval is 0 (firstrun asserts the count; this asserts the durations)", async () => {
    const flaky = startFlakyServer();
    const slept: number[] = [];
    try {
      await expect(
        pollForToken(flaky.url, "sess-1", 0, async (ms) => {
          slept.push(ms);
        }),
      ).rejects.toThrow(/network unreachable/);
      expect(slept).toEqual([5_000, 5_000, 5_000, 5_000, 5_000]);
    } finally {
      flaky.stop();
    }
  });

  test("an interval above the floor wins: interval 7 -> 7s between failed polls", async () => {
    const flaky = startFlakyServer();
    const slept: number[] = [];
    try {
      await expect(
        pollForToken(flaky.url, "sess-1", 7, async (ms) => {
          slept.push(ms);
        }),
      ).rejects.toThrow(/network unreachable/);
      expect(slept).toEqual([7_000, 7_000, 7_000, 7_000, 7_000]);
    } finally {
      flaky.stop();
    }
  });

  test("the consecutive-failure counter RESETS on any successful response: 10 total failures never abort when broken by one good poll", async () => {
    // The injected sleep doubles as a scheduling hook: the SAME always-bound
    // server flips between refusing and answering, on cue. Timeline
    // (interval 0, every poll hits the one listener):
    //   polls 1-5   refuse -> network failures 1..5 (one below abort)
    //   sleep #5    flip to answering "pending"
    //   poll 6      pending -> counter resets to 0
    //   sleep #6    flip back to refusing
    //   polls 7-11  network failures 1..5 again — WITHOUT the reset this
    //               run would have aborted at poll 7 (failure #6)
    //   sleep #11   flip to answering with the token
    //   poll 12     token issued
    const flaky = startFlakyServer();
    let sleeps = 0;

    try {
      const token = await pollForToken(flaky.url, "sess-1", 0, async () => {
        sleeps++;
        if (sleeps === 5) flaky.respond({ status: "pending" });
        else if (sleeps === 6) flaky.refuse();
        else if (sleeps === 11) flaky.respond({ token: "jwt-after-reset" });
      });
      expect(token).toBe("jwt-after-reset");
      expect(sleeps).toBe(11);
    } finally {
      flaky.stop();
    }
  });
});

describe("checkToken", () => {
  test("GETs /me with the stored JWT as a Bearer token", async () => {
    const stub = startScriptedStub([{ status: 200, body: { ok: true } }]);
    try {
      await checkToken(stub.url, "jwt-abc");
      expect(stub.requests).toEqual([
        {
          method: "GET",
          path: "/me",
          contentType: null,
          authorization: "Bearer jwt-abc",
          body: undefined,
        },
      ]);
    } finally {
      stub.stop();
    }
  });

  test("401 -> throws UnauthorizedError (the one signal run() treats as a logout cue)", async () => {
    const stub = startScriptedStub([{ status: 401 }]);
    try {
      const err = await checkToken(stub.url, "stale-jwt").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnauthorizedError);
    } finally {
      stub.stop();
    }
  });

  test("5xx resolves as a no-op — a server blip must NOT read as 'logged out' (run.ts falls through and keeps the JWT)", async () => {
    const stub = startScriptedStub([{ status: 503 }]);
    try {
      await expect(checkToken(stub.url, "jwt-abc")).resolves.toBeUndefined();
    } finally {
      stub.stop();
    }
  });
});
