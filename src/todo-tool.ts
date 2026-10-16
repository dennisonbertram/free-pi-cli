// A todo list the model keeps for itself, plus a `/todos` command, a live
// widget above the input box, and a progress line in the conversation.
// Ported from pi's examples/extensions/todo.ts. State lives in custom session
// entries and tool result details (not a file), so the list follows session
// branches and is rebuilt on resume. Own module (not packages/pi-ads), like
// usage-tool.ts: ad content must never reach a tool the model can call (KTD5).
//
// The widget and the progress line are UI-only and are built from the state,
// never from tool result `content`, so they cannot reach the model.
//
// Differences from pi's example: typebox literals instead of pi-ai's
// StringEnum, and plain objects implementing pi-tui's Component interface
// (render/invalidate) instead of importing pi-tui, so the CLI needs no new
// dependency.
import type { ExtensionAPI, ExtensionContext, InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resultLines, widgetLines, type Todo, type TodoDetails, type TodoStyle } from "./todo-view";

export const TODO_TOOL_NAME = "todo";
export const TODO_WIDGET_ID = "freepi-todo";
export type { Todo };

/** Custom session entry type holding a snapshot after every mutation (see appendEntry below). */
export const TODO_ENTRY_TYPE = "free-pi-todo";

/** How long a finished list stays on screen before the widget clears. */
export const ALL_DONE_LINGER_MS = 3000;
/**
 * pi keeps widgets in a Map and a re-set moves the widget to the end, i.e.
 * below widgets set earlier. The ad banner re-sets itself every 10 minutes,
 * which would put it under this widget. Re-setting ours on this period puts
 * the ad back above it (pi has no supported ordering option).
 */
export const REASSERT_ORDER_MS = 15_000;

export interface TodoTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: TodoTimers = {
  setTimeout: (fn, ms) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

const PARAMS = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("toggle"), Type.Literal("clear")]),
  text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
  id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
});

/** A usable snapshot has an array of todos and a numeric nextId; pi writes `details: {}` for failed calls. */
function asSnapshot(value: unknown): { todos: Todo[]; nextId: number } | undefined {
  const v = value as { todos?: unknown; nextId?: unknown } | undefined | null;
  if (!v || !Array.isArray(v.todos) || typeof v.nextId !== "number") return undefined;
  return { todos: v.todos as Todo[], nextId: v.nextId };
}

export function formatTodos(todos: readonly Todo[]): string {
  return todos.length ? todos.map((t) => `[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n") : "No todos";
}

function styleFrom(theme: Theme): TodoStyle {
  return {
    bold: (s) => theme.bold(s),
    dim: (s) => theme.fg("dim", s),
    accent: (s) => theme.fg("accent", s),
    error: (s) => theme.fg("error", s),
  };
}

export function createTodoToolExtension(options: { timers?: TodoTimers } = {}): InlineExtension {
  const timers = options.timers ?? realTimers;
  return {
    name: "free-pi-todo",
    factory(pi: ExtensionAPI) {
      let todos: Todo[] = [];
      let nextId = 1;

      // --- live widget above the input box --------------------------------
      let widgetCtx: ExtensionContext | undefined;
      let lingerTimer: unknown;
      let orderTimer: unknown;

      const stopTimers = () => {
        if (lingerTimer !== undefined) timers.clearTimeout(lingerTimer);
        if (orderTimer !== undefined) timers.clearInterval(orderTimer);
        lingerTimer = orderTimer = undefined;
      };
      const hideWidget = () => {
        stopTimers();
        try {
          widgetCtx?.ui.setWidget(TODO_WIDGET_ID, undefined);
        } catch {
          // the UI may already be gone at shutdown
        }
      };
      const showWidget = () => {
        try {
          widgetCtx?.ui.setWidget(TODO_WIDGET_ID, (_tui, theme) => {
            const style = styleFrom(theme);
            return {
              // pi pads string widgets by one column; do the same.
              render: (width: number) => widgetLines(todos, Math.max(1, width - 2), style).map((l) => ` ${l}`),
              invalidate() {},
            };
          });
        } catch {
          // best effort: never let a UI error fail a todo call
        }
      };
      /** Sync the widget with `todos`. `replay`: state was just rebuilt from the session, so a finished list is not shown. */
      const refreshWidget = (ctx: ExtensionContext, replay = false) => {
        if (ctx?.mode !== "tui") return;
        widgetCtx = ctx;
        const hasOpen = todos.some((t) => !t.done);
        if (todos.length === 0 || (!hasOpen && replay)) {
          hideWidget();
          return;
        }
        if (lingerTimer !== undefined) {
          timers.clearTimeout(lingerTimer);
          lingerTimer = undefined;
        }
        showWidget();
        if (orderTimer === undefined) orderTimer = timers.setInterval(showWidget, REASSERT_ORDER_MS);
        if (!hasOpen) {
          lingerTimer = timers.setTimeout(() => {
            lingerTimer = undefined;
            hideWidget();
          }, ALL_DONE_LINGER_MS);
        }
      };

      // Replay this branch; the last valid snapshot wins. Snapshots come from
      // custom entries (written on every mutation, so they survive calls made
      // through codemode, whose nested tool results pi does not store) and from
      // top-level todo tool results.
      const reconstructState = (ctx: ExtensionContext) => {
        todos = [];
        nextId = 1;
        for (const entry of ctx.sessionManager.getBranch()) {
          let snap: ReturnType<typeof asSnapshot>;
          if (entry.type === "custom" && entry.customType === TODO_ENTRY_TYPE) snap = asSnapshot(entry.data);
          else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === TODO_TOOL_NAME)
            snap = asSnapshot(entry.message.details);
          if (snap) {
            todos = snap.todos.map((t) => ({ ...t }));
            nextId = snap.nextId;
          }
        }
        refreshWidget(ctx, true);
      };
      pi.on("session_start", async (_event, ctx) => reconstructState(ctx));
      pi.on("session_tree", async (_event, ctx) => reconstructState(ctx));
      pi.on("session_shutdown", async () => {
        stopTimers();
        widgetCtx = undefined;
      });

      const result = (ctx: ExtensionContext, text: string, action: TodoDetails["action"], error?: string, item?: Todo) => {
        const snapshot = { todos: todos.map((t) => ({ ...t })), nextId };
        if (action !== "list" && !error) pi.appendEntry(TODO_ENTRY_TYPE, snapshot);
        if (action !== "list" && !error) refreshWidget(ctx);
        return {
          content: [{ type: "text" as const, text }],
          details: { action, ...snapshot, ...(item ? { item: { ...item } } : {}), ...(error ? { error } : {}) } as TodoDetails,
        };
      };

      pi.registerTool({
        name: TODO_TOOL_NAME,
        label: "Todo",
        description: "Manage a todo list. Actions: list, add (text), toggle (id), clear",
        promptSnippet: "Track your own multi-step work in a todo list: add items, toggle them done, list them",
        parameters: PARAMS,
        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
          switch (params.action) {
            case "list":
              return result(ctx, formatTodos(todos), "list");
            case "add": {
              if (!params.text) return result(ctx, "Error: text required for add", "add", "text required");
              const todo: Todo = { id: nextId++, text: params.text, done: false };
              todos.push(todo);
              return result(ctx, `Added todo #${todo.id}: ${todo.text}`, "add", undefined, todo);
            }
            case "toggle": {
              if (params.id === undefined) return result(ctx, "Error: id required for toggle", "toggle", "id required");
              const todo = todos.find((t) => t.id === params.id);
              if (!todo) return result(ctx, `Todo #${params.id} not found`, "toggle", `#${params.id} not found`);
              todo.done = !todo.done;
              return result(ctx, `Todo #${todo.id} ${todo.done ? "completed" : "uncompleted"}`, "toggle", undefined, todo);
            }
            case "clear": {
              const count = todos.length;
              todos = [];
              nextId = 1;
              return result(ctx, `Cleared ${count} todos`, "clear");
            }
            default:
              return result(ctx, `Unknown action: ${String(params.action)}`, "list", "unknown action");
          }
        },

        // Conversation rendering only; the model sees `content` above, unchanged.
        // Calls made from a codemode script are nested, which pi does not render.
        renderCall() {
          return { render: () => [], invalidate() {} };
        },
        renderResult(res, _opts, theme) {
          const details = res.details as TodoDetails | undefined;
          const lines = details?.action
            ? resultLines(details, styleFrom(theme))
            : [res.content[0]?.type === "text" ? res.content[0].text : ""];
          return { render: () => lines, invalidate() {} };
        },
      });

      pi.registerCommand("todos", {
        description: "Show all todos on the current branch",
        handler: async (_args, ctx) => {
          ctx.ui.notify(formatTodos(todos), "info");
        },
      });
    },
  };
}
