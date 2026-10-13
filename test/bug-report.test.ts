import { InteractiveMode } from "@earendil-works/pi-coding-agent";
import { describe, expect, test } from "bun:test";
import {
  buildBugRequest,
  makeBugHandler,
  installBugHandler,
  BUG_USAGE,
  mapBugFailure,
  parseBugCommand,
  sendBugReport,
} from "../src/bug-report";
import { CLI_VERSION } from "../src/version";

describe("parseBugCommand", () => {
  test("report, usage, and non-commands", () => {
    expect(parseBugCommand("/bug the diff tool crashed")).toEqual({ kind: "report", description: "the diff tool crashed" });
    expect(parseBugCommand("  /bug\tx\ny  ")).toEqual({ kind: "report", description: "x\ny" });
    expect(parseBugCommand("/bug")).toEqual({ kind: "usage" });
    expect(parseBugCommand("/bug   ")).toEqual({ kind: "usage" });
    expect(parseBugCommand("/bugs foo")).toEqual({ kind: "none" });
    expect(parseBugCommand("hello /bug")).toEqual({ kind: "none" });
  });
});

describe("buildBugRequest / mapBugFailure", () => {
  test("includes cli version, session and model", () => {
    expect(buildBugRequest("d", { sessionId: "s", model: "m" })).toEqual({
      description: "d",
      session_id: "s",
      cli_version: CLI_VERSION,
      model: "m",
    });
  });
  test("maps statuses to distinct messages", () => {
    expect(mapBugFailure(401)).toContain("signed out");
    expect(mapBugFailure(429)).toContain("limit");
    expect(mapBugFailure(413)).toContain("too large");
    expect(mapBugFailure(400)).toContain("too long");
    expect(mapBugFailure(500)).toContain("500");
  });
});

describe("sendBugReport", () => {
  const fake = (h: (url: string, init?: RequestInit) => Response) =>
    ((u: string, i?: RequestInit) => Promise.resolve(h(u, i))) as unknown as typeof fetch;
  test("posts with the Bearer JWT and returns the id", async () => {
    let seen: { url: string; init?: RequestInit } | undefined;
    const r = await sendBugReport(
      { baseUrl: "https://api.test", getToken: () => "jwt", fetchImpl: fake((url, init) => ((seen = { url, init }), Response.json({ id: "abc" }))) },
      { description: "d" },
    );
    expect(r).toEqual({ ok: true, id: "abc" });
    expect(seen?.url).toBe("https://api.test/bug-reports");
    expect((seen?.init?.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    expect(JSON.parse(seen!.init!.body as string)).toEqual({ description: "d" });
  });
  test("429, network error and malformed success all fail with a message", async () => {
    const base = { baseUrl: "https://api.test", getToken: () => "t" };
    const r429 = await sendBugReport({ ...base, fetchImpl: fake(() => new Response("{}", { status: 429 })) }, { description: "d" });
    expect(r429.ok).toBe(false);
    const rNet = await sendBugReport({ ...base, fetchImpl: (() => Promise.reject(new Error("down"))) as unknown as typeof fetch }, { description: "d" });
    expect(rNet.ok === false && rNet.message).toContain("check your connection");
    const rBad = await sendBugReport({ ...base, fetchImpl: fake(() => Response.json({ nope: 1 })) }, { description: "d" });
    expect(rBad.ok).toBe(false);
  });
});

describe("/bug handler hook", () => {
  test("pi still has the handleBugCommand method we replace", () => {
    expect(typeof (InteractiveMode.prototype as unknown as { handleBugCommand: unknown }).handleBugCommand).toBe("function");
  });

  function fakeMode(editorText = "") {
    const m = {
      session: { sessionId: "sess", model: { id: "mod" } },
      editor: { text: editorText, getText() { return this.text; }, setText(t: string) { this.text = t; } },
      status: [] as string[],
      errors: [] as string[],
      showStatus(x: string) { this.status.push(x); },
      showError(x: string) { this.errors.push(x); },
    };
    return m;
  }
  const f = (h: () => Response) => (() => Promise.resolve(h())) as unknown as typeof fetch;

  test("no hint shows usage and sends nothing", async () => {
    const m = fakeMode();
    let called = false;
    await makeBugHandler(m, { baseUrl: "u", getToken: () => "t", fetchImpl: f(() => ((called = true), Response.json({ id: "1" }))) })(undefined);
    expect(m.status).toEqual([BUG_USAGE]);
    expect(called).toBe(false);
  });
  test("success shows the thank-you with the id and posts session/model", async () => {
    const m = fakeMode();
    let body = "";
    const fetchImpl = ((_u: string, i: RequestInit) => ((body = i.body as string), Promise.resolve(Response.json({ id: "9" })))) as unknown as typeof fetch;
    await makeBugHandler(m, { baseUrl: "u", getToken: () => "t", fetchImpl })("it broke");
    expect(m.status[0]).toBe("Thanks — bug report received (#9).");
    expect(JSON.parse(body)).toMatchObject({ description: "it broke", session_id: "sess", model: "mod" });
  });
  test("failure restores the text when the editor is empty, but not over new typing", async () => {
    const fail = { baseUrl: "u", getToken: () => "t", fetchImpl: f(() => new Response("{}", { status: 429 })) };
    const m = fakeMode();
    await makeBugHandler(m, fail)("it broke");
    expect(m.editor.text).toBe("/bug it broke");
    expect(m.errors[0]).toContain("limit");
    const m2 = fakeMode("typing");
    await makeBugHandler(m2, fail)("it broke");
    expect(m2.editor.text).toBe("typing");
  });
  test("installBugHandler replaces the instance method", () => {
    const m = fakeMode() as unknown as { handleBugCommand?: unknown };
    installBugHandler(m, { baseUrl: "u", getToken: () => "t" });
    expect(typeof m.handleBugCommand).toBe("function");
  });
});
