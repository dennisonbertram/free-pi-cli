import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ALL_DONE_LINGER_MS, createTodoToolExtension, REASSERT_ORDER_MS, TODO_WIDGET_ID, type TodoTimers } from "../src/todo-tool";

type Exec = (id: string, params: Record<string, unknown>, s: unknown, u: unknown, ctx: unknown) => Promise<{ content: Array<{ text: string }> }>;
type Content = ((tui: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;

function fakeTimers() {
  let now = 0;
  let nextHandle = 1;
  const timeouts = new Map<number, { at: number; fn: () => void }>();
  const intervals = new Map<number, { every: number; next: number; fn: () => void }>();
  const timers: TodoTimers = {
    setTimeout: (fn, ms) => {
      const h = nextHandle++;
      timeouts.set(h, { at: now + ms, fn });
      return h;
    },
    clearTimeout: (h) => void timeouts.delete(h as number),
    setInterval: (fn, ms) => {
      const h = nextHandle++;
      intervals.set(h, { every: ms, next: now + ms, fn });
      return h;
    },
    clearInterval: (h) => void intervals.delete(h as number),
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [
        ...[...timeouts].map(([h, t]) => ({ h, at: t.at, kind: "t" as const })),
        ...[...intervals].map(([h, t]) => ({ h, at: t.next, kind: "i" as const })),
      ]
        .filter((d) => d.at <= end)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      if (due.kind === "t") {
        const t = timeouts.get(due.h)!;
        timeouts.delete(due.h);
        t.fn();
      } else {
        const t = intervals.get(due.h)!;
        t.next += t.every;
        t.fn();
      }
    }
    now = end;
  };
  return { timers, advance, pending: () => timeouts.size + intervals.size };
}

function setup() {
  const clock = fakeTimers();
  const handlers = new Map<string, (e: unknown, c: unknown) => Promise<void>>();
  let tool!: { execute: Exec; renderResult: (r: unknown, o: unknown, t: unknown) => { render(w: number): string[] } };
  const pi = {
    on: (e: string, h: (e: unknown, c: unknown) => Promise<void>) => handlers.set(e, h),
    registerTool: (t: typeof tool) => (tool = t),
    registerCommand: () => {},
    appendEntry: () => {},
  } as unknown as ExtensionAPI;
  (createTodoToolExtension({ timers: clock.timers }) as { factory: (pi: ExtensionAPI) => void }).factory(pi);

  const calls: Array<{ key: string; content: Content }> = [];
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
  const ctx = {
    mode: "tui",
    ui: { setWidget: (key: string, content: Content) => calls.push({ key, content }) },
    sessionManager: { getBranch: () => [] },
  };
  const run = (params: Record<string, unknown>) => tool.execute("c", params, undefined, undefined, ctx);
  const lastLines = (width = 100) => {
    const last = calls[calls.length - 1]!;
    return last.content ? last.content(undefined, theme).render(width) : undefined;
  };
  return { clock, handlers, tool, calls, ctx, run, lastLines };
}

describe("live todo widget", () => {
  test("a mutation sets the widget with lines; a list call does not touch it", async () => {
    const s = setup();
    await s.run({ action: "list" });
    expect(s.calls).toEqual([]);
    await s.run({ action: "add", text: "one" });
    await s.run({ action: "add", text: "two" });
    expect(s.calls.every((c) => c.key === TODO_WIDGET_ID)).toBe(true);
    expect(s.lastLines()).toEqual([" Todos 0/2  ▸ one  ○ two"]);
    expect(s.lastLines(12)).toEqual([" Todos 0/2", " ▸ one", " ○ two"]);
  });

  test("when every item is done the widget stays about 3s, then clears", async () => {
    const s = setup();
    await s.run({ action: "add", text: "one" });
    await s.run({ action: "toggle", id: 1 });
    expect(s.lastLines()).toEqual([" Todos 1/1  ✓ one"]);
    s.clock.advance(ALL_DONE_LINGER_MS - 1);
    expect(s.lastLines()).toBeDefined();
    s.clock.advance(1);
    expect(s.calls[s.calls.length - 1]!.content).toBeUndefined();
    expect(s.clock.pending()).toBe(0);
  });

  test("a new open item during the linger cancels the clear", async () => {
    const s = setup();
    await s.run({ action: "add", text: "one" });
    await s.run({ action: "toggle", id: 1 });
    await s.run({ action: "add", text: "two" });
    s.clock.advance(ALL_DONE_LINGER_MS * 2);
    expect(s.lastLines()).toEqual([" Todos 1/2  ✓ one  ▸ two"]);
  });

  test("clear removes the widget immediately and stops the timers", async () => {
    const s = setup();
    await s.run({ action: "add", text: "one" });
    await s.run({ action: "clear" });
    expect(s.calls[s.calls.length - 1]!.content).toBeUndefined();
    expect(s.clock.pending()).toBe(0);
  });

  test("the widget is re-set periodically so the ad banner (set earlier, re-set every 10 min) stays above it", async () => {
    const s = setup();
    await s.run({ action: "add", text: "one" });
    const before = s.calls.length;
    s.clock.advance(REASSERT_ORDER_MS * 2);
    expect(s.calls.length).toBe(before + 2);
  });

  test("session_shutdown clears timers so nothing fires afterwards", async () => {
    const s = setup();
    await s.run({ action: "add", text: "one" });
    await s.run({ action: "toggle", id: 1 });
    await s.handlers.get("session_shutdown")!({}, s.ctx);
    const before = s.calls.length;
    s.clock.advance(60_000);
    expect(s.calls.length).toBe(before);
    expect(s.clock.pending()).toBe(0);
  });

  test("replay on session_start shows an open list and hides a finished one", async () => {
    const s = setup();
    const snap = (todos: unknown[]) => ({ type: "custom", customType: "free-pi-todo", data: { todos, nextId: 9 } });
    await s.handlers.get("session_start")!({}, { ...s.ctx, sessionManager: { getBranch: () => [snap([{ id: 1, text: "a", done: false }])] } });
    expect(s.lastLines()).toEqual([" Todos 0/1  ▸ a"]);
    await s.handlers.get("session_tree")!({}, { ...s.ctx, sessionManager: { getBranch: () => [snap([{ id: 1, text: "a", done: true }])] } });
    expect(s.calls[s.calls.length - 1]!.content).toBeUndefined();
  });

  test("non-TUI modes never touch the widget", async () => {
    const s = setup();
    const res = await s.tool.execute("c", { action: "add", text: "x" }, undefined, undefined, { ...s.ctx, mode: "print" });
    expect(res.content[0]!.text).toBe("Added todo #1: x");
    expect(s.calls).toEqual([]);
  });
});

describe("todo result rendering", () => {
  test("renders the progress line from details; the model-facing content is unchanged plain text", async () => {
    const s = setup();
    await s.run({ action: "add", text: "a" });
    const res = (await s.run({ action: "add", text: "b" })) as unknown as { content: Array<{ text: string }>; details: unknown };
    expect(res.content[0]!.text).toBe("Added todo #2: b");
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    expect(s.tool.renderResult(res, {}, theme).render(80)).toEqual(["● todo 0/2  + b", "  next: a"]);
  });

  test("details written as {} by a failed call fall back to the content text", () => {
    const s = setup();
    const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
    expect(s.tool.renderResult({ content: [{ type: "text", text: "boom" }], details: {} }, {}, theme).render(80)).toEqual(["boom"]);
  });
});
