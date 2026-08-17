import {
  AuthTokenResponseSchema,
  GithubDeviceResponseSchema,
  type AuthTokenResponse,
  type GithubDeviceResponse,
} from "@freepi/shared";

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
  }
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<Response> {
  return fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * postJson with bounded retry on NETWORK failures only (HTTP responses are
 * returned as-is). One dropped packet on flaky wifi must not kill first-run
 * before the device code even prints (found live 2026-08-15: `fetch failed`
 * on the initial /auth/github/device call exited the whole flow — the 0.1.1
 * fix covered only the token poll).
 */
async function postJsonRetry(
  baseUrl: string,
  path: string,
  body: unknown,
  attempts = 4,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await postJson(baseUrl, path, body);
    } catch (err) {
      if (attempt >= attempts) {
        throw new Error(
          `network unreachable after ${attempts} attempts (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      await sleep(1_500 * attempt);
    }
  }
}

export async function startDeviceFlow(baseUrl: string): Promise<GithubDeviceResponse> {
  const res = await postJsonRetry(baseUrl, "/auth/github/device", {});
  if (!res.ok) throw new Error(`device flow start failed: HTTP ${res.status}`);
  return GithubDeviceResponseSchema.parse(await res.json());
}

export async function submitConsent(
  baseUrl: string,
  sessionId: string,
  consentVersion: string,
): Promise<void> {
  const res = await postJsonRetry(baseUrl, "/auth/consent", {
    session_id: sessionId,
    consent_version: consentVersion,
  });
  if (!res.ok) throw new Error(`consent submission failed: HTTP ${res.status}`);
}

/** Poll /auth/token until a JWT is issued. Sleeps `interval` seconds between polls. */
export async function pollForToken(
  baseUrl: string,
  sessionId: string,
  interval: number,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  // Transient network failures (flaky wifi, a DNS blip) must not kill the
  // login mid-poll — the user is off in a browser and comes back to a dead
  // prompt. Tolerate a bounded run of consecutive fetch failures and keep
  // polling; only a persistent outage aborts. (Found live 2026-08-15: one
  // "fetch failed" during resolver flap exited the whole first-run flow.)
  let consecutiveNetworkFailures = 0;
  for (;;) {
    let res: Response;
    try {
      res = await postJson(baseUrl, "/auth/token", { session_id: sessionId });
      consecutiveNetworkFailures = 0;
    } catch (err) {
      consecutiveNetworkFailures++;
      if (consecutiveNetworkFailures >= 6) {
        throw new Error(
          `token poll failed: network unreachable after ${consecutiveNetworkFailures} attempts (${err instanceof Error ? err.message : String(err)})`,
        );
      }
      await sleep(Math.max(interval, 5) * 1000);
      continue;
    }
    // The server sends consent_required as a 403, not as a 200 body, so the
    // generic !res.ok throw below would swallow it and report a bare
    // "HTTP 403" instead of the one message that says what to do about it.
    if (res.status === 403) {
      const body = (await res.json().catch(() => undefined)) as { code?: string } | undefined;
      if (body?.code === "consent_required") {
        throw new Error("consent_required: server did not record consent before polling");
      }
    }
    if (!res.ok) throw new Error(`token poll failed: HTTP ${res.status}`);
    const parsed: AuthTokenResponse = AuthTokenResponseSchema.parse(await res.json());
    if ("token" in parsed) return parsed.token;
    if ("code" in parsed && parsed.code === "consent_required") {
      throw new Error("consent_required: server did not record consent before polling");
    }
    // GitHub answers slow_down when polled too fast, and the server forwards
    // the interval it asked for. Ignoring it earns a hard rate limit.
    const retryAfter =
      "retry_after" in parsed && typeof parsed.retry_after === "number" ? parsed.retry_after : 0;
    await sleep(Math.max(interval, retryAfter) * 1000);
  }
}

/** GET /me with the stored JWT. Throws UnauthorizedError on 401; any other response is a no-op. */
export async function checkToken(baseUrl: string, jwt: string): Promise<void> {
  const res = await fetch(new URL("/me", baseUrl), {
    headers: { authorization: `Bearer ${jwt}` },
  });
  if (res.status === 401) throw new UnauthorizedError();
}
