import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createTodoToolExtension, TODO_TOOL_NAME } from "../src/todo-tool";

type Exec = (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; details: unknown }>;
type Handler = (event: unknown, ctx: unknown) => Promise<void>;

function setup() {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  let tool: { name: string; execute: Exec } | undefined;
  const entries: Array<{ type: "custom"; customType: string; data: unknown }> = [];
  const pi = {
    appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
    on: (e: string, h: Handler) => handlers.set(e, h),
    registerTool: (t: { name: string; execute: Exec }) => {
      tool = t;
    },
    registerCommand: (n: string, c: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.set(n, c),
  } as unknown as ExtensionAPI;
  const ext = createTodoToolExtension() as { name: string; factory: (pi: ExtensionAPI) => void };
  ext.factory(pi);
  return { ext, handlers, commands, entries, tool: tool! };
}

const text = async (t: { execute: Exec }, params: Record<string, unknown>) => (await t.execute("c", params)).content[0]!.text;

describe("todo tool", () => {
  test("is named free-pi-todo and registers tool `todo` plus /todos", () => {
    const { ext, tool, commands } = setup();
    expect(ext.name).toBe("free-pi-todo");
    expect(tool.name).toBe(TODO_TOOL_NAME);
    expect([...commands.keys()]).toEqual(["todos"]);
  });

  test("add, toggle, list, clear", async () => {
    const { tool } = setup();
    expect(await text(tool, { action: "list" })).toBe("No todos");
    expect(await text(tool, { action: "add", text: "write tests" })).toBe("Added todo #1: write tests");
    await text(tool, { action: "add", text: "ship" });
    expect(await text(tool, { action: "toggle", id: 1 })).toBe("Todo #1 completed");
    expect(await text(tool, { action: "list" })).toBe("[x] #1: write tests\n[ ] #2: ship");
    expect(await text(tool, { action: "toggle", id: 9 })).toBe("Todo #9 not found");
    expect(await text(tool, { action: "add" })).toBe("Error: text required for add");
    expect(await text(tool, { action: "clear" })).toBe("Cleared 2 todos");
    expect(await text(tool, { action: "list" })).toBe("No todos");
  });

  test("/todos notifies with the list", async () => {
    const { tool, commands } = setup();
    await tool.execute("c", { action: "add", text: "a" });
    const notes: string[] = [];
    await commands.get("todos")!.handler("", { ui: { notify: (m: string) => notes.push(m) } });
    expect(notes).toEqual(["[ ] #1: a"]);
  });

  test("rebuilds state from the session branch on session_start (resume)", async () => {
    const first = setup();
    await first.tool.execute("c", { action: "add", text: "one" });
    const last = await first.tool.execute("c", { action: "add", text: "two" });
    const branch = [
      { type: "message", message: { role: "toolResult", toolName: "todo", details: last.details } },
      { type: "message", message: { role: "toolResult", toolName: "bash", details: { nope: 1 } } },
    ];
    const resumed = setup();
    await resumed.handlers.get("session_start")!({}, { sessionManager: { getBranch: () => branch } });
    expect(await text(resumed.tool, { action: "list" })).toBe("[ ] #1: one\n[ ] #2: two");
    expect(await text(resumed.tool, { action: "add", text: "three" })).toBe("Added todo #3: three");
    // switching to an empty branch resets
    await resumed.handlers.get("session_tree")!({}, { sessionManager: { getBranch: () => [] } });
    expect(await text(resumed.tool, { action: "list" })).toBe("No todos");
  });

  test("a failed call that pi records with details {} does not break replay (P3)", async () => {
    const first = setup();
    const one = await first.tool.execute("c", { action: "add", text: "first" });
    const two = await first.tool.execute("c", { action: "add", text: "second" });
    const branch = [
      { type: "message", message: { role: "toolResult", toolName: "todo", details: one.details } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: {} } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: { todos: "x", nextId: 1 } } },
      { type: "message", message: { role: "toolResult", toolName: "todo", details: two.details } },
    ];
    const resumed = setup();
    await resumed.handlers.get("session_start")!({}, { sessionManager: { getBranch: () => branch } });
    expect(await text(resumed.tool, { action: "list" })).toBe("[ ] #1: first\n[ ] #2: second");
  });

  test("mutations append a custom entry, so state survives when no top-level tool result exists (codemode, P2)", async () => {
    const first = setup();
    await first.tool.execute("nested/1", { action: "add", text: "via codemode" });
    await first.tool.execute("nested/2", { action: "add", text: "two" });
    await first.tool.execute("nested/3", { action: "toggle", id: 1 });
    await first.tool.execute("nested/4", { action: "list" });
    expect(first.entries.map((e) => e.customType)).toEqual(["free-pi-todo", "free-pi-todo", "free-pi-todo"]);
    // Only custom entries on the branch (nested results are never stored).
    const resumed = setup();
    await resumed.handlers.get("session_start")!({}, { sessionManager: { getBranch: () => first.entries } });
    expect(await text(resumed.tool, { action: "list" })).toBe("[x] #1: via codemode\n[ ] #2: two");
  });

  test("tree reconstruction picks the branch's last snapshot", async () => {
    const first = setup();
    await first.tool.execute("c", { action: "add", text: "a" });
    await first.tool.execute("c", { action: "add", text: "b" });
    const [afterA, afterB] = first.entries;
    const resumed = setup();
    await resumed.handlers.get("session_tree")!({}, { sessionManager: { getBranch: () => [afterA] } });
    expect(await text(resumed.tool, { action: "list" })).toBe("[ ] #1: a");
    await resumed.handlers.get("session_tree")!({}, { sessionManager: { getBranch: () => [afterA, afterB] } });
    expect(await text(resumed.tool, { action: "list" })).toBe("[ ] #1: a\n[ ] #2: b");
  });
});
