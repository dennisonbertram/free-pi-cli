import { describe, expect, test } from "bun:test";
import { checkClientVersion } from "../src/update-check";

function fakeFetch(handler: () => Response | Promise<Response>): typeof fetch {
  return (async () => handler()) as unknown as typeof fetch;
}

describe("checkClientVersion (#37)", () => {
  test("block: cli version below min", async () => {
    const fetchImpl = fakeFetch(() => Response.json({ min: "0.2.0", latest: "0.3.0" }));
    // #37 codex fix: block now carries `latest` too, so the auto-update
    // message downstream can name the version.
    expect(await checkClientVersion("https://api.test", "0.1.0", fetchImpl)).toEqual({
      action: "block",
      latest: "0.3.0",
    });
  });

  test("notice: cli version between min and latest", async () => {
    const fetchImpl = fakeFetch(() => Response.json({ min: "0.1.0", latest: "0.3.0" }));
    expect(await checkClientVersion("https://api.test", "0.2.0", fetchImpl)).toEqual({
      action: "notice",
      latest: "0.3.0",
    });
  });

  test("ok: cli version at or above latest", async () => {
    const fetchImpl = fakeFetch(() => Response.json({ min: "0.1.0", latest: "0.3.0" }));
    expect(await checkClientVersion("https://api.test", "0.3.0", fetchImpl)).toEqual({ action: "ok" });
  });

  test("boundary: exactly at min is not a block", async () => {
    const fetchImpl = fakeFetch(() => Response.json({ min: "0.2.0", latest: "0.3.0" }));
    expect(await checkClientVersion("https://api.test", "0.2.0", fetchImpl)).toEqual({
      action: "notice",
      latest: "0.3.0",
    });
  });

  describe("R4: every failure mode falls through to ok, never block", () => {
    test("network error / timeout", async () => {
      const fetchImpl = fakeFetch(() => {
        throw new DOMException("The operation timed out.", "TimeoutError");
      });
      expect(await checkClientVersion("https://api.test", "0.0.1", fetchImpl)).toEqual({ action: "ok" });
    });

    test("non-200 response", async () => {
      const fetchImpl = fakeFetch(() => new Response("boom", { status: 500 }));
      expect(await checkClientVersion("https://api.test", "0.0.1", fetchImpl)).toEqual({ action: "ok" });
    });

    test("malformed (non-JSON) body", async () => {
      const fetchImpl = fakeFetch(() => new Response("not json", { status: 200 }));
      expect(await checkClientVersion("https://api.test", "0.0.1", fetchImpl)).toEqual({ action: "ok" });
    });

    test("well-formed JSON missing the expected shape", async () => {
      const fetchImpl = fakeFetch(() => Response.json({ nope: true }));
      expect(await checkClientVersion("https://api.test", "0.0.1", fetchImpl)).toEqual({ action: "ok" });
    });

    test("non-semver min/latest values", async () => {
      const fetchImpl = fakeFetch(() => Response.json({ min: "not-a-version", latest: "also-not" }));
      expect(await checkClientVersion("https://api.test", "0.0.1", fetchImpl)).toEqual({ action: "ok" });
    });
  });

  describe("trial: model + notice threaded through", () => {
    test("ok response surfaces server model + notice", async () => {
      const fetchImpl = fakeFetch(() =>
        Response.json({ min: "0.1.0", latest: "0.3.0", model: "Ox Alpha", notice: "trial notice" }),
      );
      expect(await checkClientVersion("https://api.test", "0.3.0", fetchImpl)).toEqual({
        action: "ok",
        model: "Ox Alpha",
        notice: "trial notice",
      });
    });

    test("notice rides along on a 'notice' (update-available) action too", async () => {
      const fetchImpl = fakeFetch(() =>
        Response.json({ min: "0.1.0", latest: "0.3.0", model: "Ox Alpha", notice: "trial notice" }),
      );
      expect(await checkClientVersion("https://api.test", "0.2.0", fetchImpl)).toEqual({
        action: "notice",
        latest: "0.3.0",
        model: "Ox Alpha",
        notice: "trial notice",
      });
    });

    test("plain {min,latest} stays exactly {action} — no undefined keys leak", async () => {
      const fetchImpl = fakeFetch(() => Response.json({ min: "0.1.0", latest: "0.3.0" }));
      expect(await checkClientVersion("https://api.test", "0.3.0", fetchImpl)).toEqual({ action: "ok" });
    });
  });
});
