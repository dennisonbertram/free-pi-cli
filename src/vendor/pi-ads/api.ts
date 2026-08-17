// Thin fetch layer shared by banner/inline/meter. Never throws: every ad or
// budget fetch failure resolves to `undefined` so the caller can clear the
// widget and move on — nothing here may block or delay the chat turn (KTD9 /
// U7 requirement).
import type { AdNextResponse, AdSlot, MeResponse } from "@freepi/shared";

export interface AdsDeps {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}

// "Never block the chat turn" needs a clock, not just a catch: a hung socket
// resolves neither way. Every caller below already maps a thrown error to
// `undefined`, so a timeout abort lands on the same path as any other failure.
const REQUEST_TIMEOUT_MS = 3_000;

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
    },
  });
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
export async function postImpression(deps: AdsDeps, adId: string, clickToken: string): Promise<void> {
  try {
    await authedFetch(deps, "/ads/impression", {
      method: "POST",
      body: JSON.stringify({ ad_id: adId, click_token: clickToken }),
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
