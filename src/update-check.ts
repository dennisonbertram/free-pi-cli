// #37: startup version check. Offline-safe by construction (R4) — every
// failure mode (throw, non-200, malformed JSON, non-semver, timeout) falls
// through to the single `return { action: "ok" }` at the bottom, never to a
// block. Uses the one shared `compareVersions` (@freepi/shared) — no second
// copy of the semver logic here.
import { ClientVersionResponseSchema, compareVersions } from "@freepi/shared";

export interface ClientVersionCheck {
  action: "block" | "notice" | "ok";
  latest?: string;
}

export async function checkClientVersion(
  baseUrl: string,
  cliVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ClientVersionCheck> {
  try {
    const res = await fetchImpl(new URL("/client-version", baseUrl), {
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return { action: "ok" };
    const parsed = ClientVersionResponseSchema.safeParse(await res.json());
    if (!parsed.success) return { action: "ok" };
    const { min, latest } = parsed.data;

    if (compareVersions(cliVersion, min) === -1) return { action: "block", latest };
    if (compareVersions(cliVersion, latest) === -1) return { action: "notice", latest };
    return { action: "ok" };
  } catch {
    return { action: "ok" };
  }
}
