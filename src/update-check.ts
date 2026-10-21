// #37: startup version check. Offline-safe by construction (R4) — every
// failure mode (throw, non-200, malformed JSON, non-semver, timeout) falls
// through to the single `return { action: "ok" }` at the bottom, never to a
// block. Uses the one shared `compareVersions` (@freepi/shared) — no second
// copy of the semver logic here.
import { ClientVersionResponseSchema, compareVersions } from "@freepi/shared";

export interface ClientVersionCheck {
  action: "block" | "notice" | "ok";
  latest?: string;
  /** Server-reported active model to display (see /client-version). */
  model?: string;
  /** #140: the selectable model catalog (id = request model, name = label). */
  models?: Array<{ id: string; name: string }>;
  /** Optional one-line startup notice (e.g. a trial data-handling disclosure). */
  notice?: string;
  /** Server-chosen Fusion planner/executor catalog ids. */
  fusion?: { planner: string; executor: string };
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
    const { min, latest, model, models, notice, fusion } = parsed.data;
    // Only attach model/models/notice when present, so a plain {min,latest}
    // response still returns exactly {action,...} (keeps the shape minimal).
    const extra: { model?: string; models?: Array<{ id: string; name: string }>; notice?: string; fusion?: { planner: string; executor: string } } = {};
    if (model !== undefined) extra.model = model;
    if (models !== undefined) extra.models = models;
    if (notice !== undefined) extra.notice = notice;
    if (fusion !== undefined) extra.fusion = fusion;

    if (compareVersions(cliVersion, min) === -1) return { action: "block", latest, ...extra };
    if (compareVersions(cliVersion, latest) === -1) return { action: "notice", latest, ...extra };
    return { action: "ok", ...extra };
  } catch {
    return { action: "ok" };
  }
}
