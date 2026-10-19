// Thin fetch layer shared by banner/inline/meter. Never throws: every ad or
// budget fetch failure resolves to `undefined` so the caller can clear the
// widget and move on — nothing here may block or delay the chat turn (KTD9 /
// U7 requirement).
import { GRAVITY_CONTEXT_HEADER, type AdNextResponse, type AdSlot, type MeResponse } from "@freepi/shared";

export interface AdsDeps {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  /** Stable logical session id; omitted by older harness-only callers. */
  sessionId?: string;
  fetchImpl?: typeof fetch;
  /** Base64url Gravity context (already size-checked); sent on /ads/next only. Undefined = send nothing. */
  getGravityContext?: () => string | undefined;
}

// "Never block the chat turn" needs a clock, not just a catch: a hung socket
// resolves neither way. Every caller below already maps a thrown error to
// `undefined`, so a timeout abort lands on the same path as any other failure.
// Above the server's 2.5 s Gravity wait, so a Gravity timeout still returns our own ad in time.
const REQUEST_TIMEOUT_MS = 5_000;

async function authedFetch(deps: AdsDeps, path: string, init?: RequestInit): Promise<Response> {
  const token = await deps.getToken();
  const doFetch = deps.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return doFetch(`${deps.baseUrl}${path}`, {
    ...init,
    signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // x-session-id is a launch-time snapshot of the logical session; an in-TUI /new/resume change after launch is not reflected (known, out of scope).
      ...(deps.sessionId && (path.startsWith("/ads/next") || path === "/ads/impression")
        ? { "x-session-id": deps.sessionId }
        : {}),
      ...(path.startsWith("/ads/next") ? gravityHeader(deps) : {}),
    },
  });
}

function gravityHeader(deps: AdsDeps): Record<string, string> {
  try {
    const ctx = deps.getGravityContext?.();
    return ctx ? { [GRAVITY_CONTEXT_HEADER]: ctx } : {};
  } catch {
    return {};
  }
}

const IMP_TIMEOUT_MS = 3_000;

function isGravityImpUrl(raw: string | undefined): raw is string {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && /(^|\.)trygravity\.(ai|com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

/**
 * Fires Gravity's impression pixel from this machine (their requirement: the
 * impression is measured where the ad is shown). Plain GET with no free-pi
 * credentials. Fire-and-forget: never awaited, errors swallowed, so it cannot
 * delay a render. Returns true when the fire was ATTEMPTED (not whether it
 * succeeded): the caller then tells the server imp_fired, because a lost
 * impression is acceptable but a double count at Gravity is not. False when
 * there was nothing to fire (own ad, no imp_url, non-Gravity host).
 */
export function fireGravityImpression(deps: AdsDeps, ad: AdNextResponse): boolean {
  if (ad.source !== "gravity" || !isGravityImpUrl(ad.imp_url)) return false;
  try {
    void Promise.resolve((deps.fetchImpl ?? fetch)(ad.imp_url, { method: "GET", signal: AbortSignal.timeout(IMP_TIMEOUT_MS) })).catch(() => {});
  } catch {
    // synchronous failure still counts as attempted
  }
  return true;
}

/** GET /ads/next?slot=<slot>. 204 (no active ad) and any failure both resolve to undefined. */
export async function fetchAdNext(deps: AdsDeps, slot: AdSlot): Promise<AdNextResponse | undefined> {
  try {
    const res = await authedFetch(deps, `/ads/next?slot=${slot}`);
    if (res.status === 204 || !res.ok) return undefined;
    return (await res.json()) as AdNextResponse;
  } catch {
    return undefined;
  }
}

/** POST /ads/impression. Best-effort tracking — failures are swallowed. */
export async function postImpression(deps: AdsDeps, adId: string, clickToken: string, impFired = false): Promise<void> {
  try {
    await authedFetch(deps, "/ads/impression", {
      method: "POST",
      body: JSON.stringify({ ad_id: adId, click_token: clickToken, ...(impFired ? { imp_fired: true } : {}) }),
    });
  } catch {
    // best-effort; never block chat on tracking failure
  }
}

/** GET /me. Any failure resolves to undefined so the meter widget clears instead of showing stale data. */
export async function fetchMe(deps: AdsDeps): Promise<MeResponse | undefined> {
  try {
    const res = await authedFetch(deps, "/me");
    if (!res.ok) return undefined;
    return (await res.json()) as MeResponse;
  } catch {
    return undefined;
  }
}
