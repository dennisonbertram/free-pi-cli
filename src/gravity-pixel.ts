// Gravity's terminal pixel (their publisher requirement: ads must be served
// through a Gravity SDK). Started by the CLI process only, after the user has
// accepted the consent version that discloses it (run.ts) — never from the ad
// extension's pi hooks. It must never block or crash startup.
import { createHash } from "node:crypto";
import { GRAVITY_CONTEXT_MAX_BYTES } from "@freepi/shared";

/** Public identifier of our Gravity pixel (not a secret). */
export const GRAVITY_PIXEL_ID = "6cd74804-0541-4d9b-899d-d7fceb465b6f";

type GravitySdk = typeof import("@gravity-ai/api");

/** `sub` of the session JWT = our user id. Unverified decode; used only to derive the same sha256 id the server sends Gravity. */
export function userIdFromJwt(jwt: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8")) as { sub?: unknown };
    return typeof payload.sub === "string" ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SDK's start() registers process.on("SIGINT"/"SIGTERM") handlers that call
 * process.exit(0) (index.mjs:815-822), which would bypass pi's terminal restore
 * and its own signal handling. They are added after async awaits (798-808), so
 * no synchronous patch can catch them. Instead, watch `newListener` and remove
 * exactly those two handlers (identified by their `shutdownSync` call) right
 * after they are added. The "exit" listener (sync persist, 811-814) is kept.
 * ponytail: matches on handler source text; breaks if the SDK renames shutdownSync (the unit test uses the same shape).
 */
function dropPixelSignalHandlers(): () => void {
  const onNew = (event: string | symbol, fn: unknown) => {
    if ((event !== "SIGINT" && event !== "SIGTERM") || typeof fn !== "function") return;
    if (!/shutdownSync/.test(Function.prototype.toString.call(fn))) return;
    queueMicrotask(() => process.removeListener(event, fn as (...args: unknown[]) => void));
  };
  process.on("newListener", onNew);
  return () => {
    // Leave the watcher in until the handlers were surely added or start() ended.
    process.removeListener("newListener", onNew);
  };
}

/**
 * Starts the pixel in the background and returns a getter for the
 * base64url-encoded Gravity context (undefined until the pixel has a session,
 * if it failed, or if the result is over the header size cap). Returns
 * undefined when disabled via FREEPI_NO_GRAVITY_PIXEL=1. Never throws.
 */
export function startGravityPixel(
  jwt: string,
  storageDir: string,
  env: NodeJS.ProcessEnv = process.env,
  load: () => Promise<GravitySdk> = () => import("@gravity-ai/api"),
): (() => string | undefined) | undefined {
  if (env.FREEPI_NO_GRAVITY_PIXEL === "1") return undefined;
  const userId = userIdFromJwt(jwt);
  if (!userId) return undefined;
  const userHash = createHash("sha256").update(userId).digest("hex");

  let sdk: GravitySdk | undefined;
  let pixel: ReturnType<GravitySdk["gravityPixel"]> | undefined;
  // Fire-and-forget: nothing awaits this, so a hung network call (the SDK's
  // start() POSTs with no timeout) cannot delay startup. Session ids exist
  // after the first few ticks; the getter returns undefined until then.
  void (async () => {
    try {
      sdk = await load();
      const p = sdk.gravityPixel({ pixelId: GRAVITY_PIXEL_ID, appName: "free-pi", storageDir });
      pixel = p;
      const stopWatching = dropPixelSignalHandlers();
      try {
        await p.start();
      } finally {
        stopWatching();
      }
    } catch {
      pixel = undefined;
    }
  })();

  return () => {
    try {
      const sessionId = pixel?.getSessionId();
      if (!sdk || !pixel || !sessionId) return undefined;
      const ctx = sdk.gravityContext({
        sessionId,
        user: { userId: userHash, gruid: pixel.getVisitorId(), grclid: pixel.getClickId(), graid: pixel.getGraid() },
      });
      const encoded = Buffer.from(JSON.stringify(ctx)).toString("base64url");
      return encoded.length <= GRAVITY_CONTEXT_MAX_BYTES ? encoded : undefined;
    } catch {
      return undefined;
    }
  };
}
