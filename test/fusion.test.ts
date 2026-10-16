import { describe, expect, test } from "bun:test";
import type { ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { FUSION_EXECUTOR_ID, FUSION_PLANNER_ID, routeFusion, type FusionState } from "../src/fusion";
import { PROVIDER_NAME } from "../src/provider";

function model(id: string): ModelRoute["model"] {
  return {
    id, name: id, provider: PROVIDER_NAME, api: "openai-completions",
    baseUrl: "http://localhost/v1", reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 8192,
  };
}

const planner = model(FUSION_PLANNER_ID);
const executor = model(FUSION_EXECUTOR_ID);
const defaultModel = model("catalog-default");
const models = { planner, executor, defaultModel };
type Request = Parameters<typeof routeFusion>[0];
const user = { role: "user", content: "Make an edit", timestamp: 1 } as const;
function result(toolName: string, isError = false): Request["messages"][number] {
  return { role: "toolResult", toolName, isError, toolCallId: "call", content: [{ type: "text", text: "result" }], timestamp: 2 };
}
function request(overrides: Partial<Request> = {}): Request {
  return { reason: "continuation", thinkingLevel: "off", messages: [user], ...overrides };
}
function failed(physicalModel = planner): ModelRouteRequest<FusionState>["failed"] {
  return {
    model: physicalModel, thinkingLevel: "off",
    message: {
      role: "assistant", content: [], api: physicalModel.api, provider: physicalModel.provider, model: physicalModel.id,
      stopReason: "error", errorMessage: "503 No capacity", timestamp: 3,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    },
  };
}

describe("Fusion routing", () => {
  test("each user message resets build to plan, even with earlier edits", () => {
    const routed = routeFusion(request({ reason: "user", state: { phase: "build" }, messages: [user, result("edit"), user] }), models);
    expect(routed.model).toBe(planner);
    expect(routed.state).toEqual({ phase: "plan" });
  });

  test.each(["read", "bash", "todo"])("%s does not trigger handoff", (tool) => {
    const state: FusionState = { phase: "plan" };
    const routed = routeFusion(request({ state, messages: [user, result(tool)] }), models);
    expect(routed.model).toBe(planner);
    expect(routed.state).toBe(state);
  });

  test.each(["edit", "write"])("successful %s starts build, failed %s stays in plan", (tool) => {
    expect(routeFusion(request({ messages: [user, result(tool)] }), models)).toMatchObject({ model: executor, state: { phase: "build" } });
    expect(routeFusion(request({ messages: [user, result(tool, true)] }), models)).toMatchObject({ model: planner, state: { phase: "plan" } });
  });

  test("an edit before the latest user message cannot trigger handoff", () => {
    expect(routeFusion(request({ messages: [user, result("edit"), user, result("read")] }), models).model).toBe(planner);
  });

  test("a successful edit still counts when later tool results are not edits", () => {
    expect(routeFusion(request({ messages: [user, result("write"), result("read")] }), models).model).toBe(executor);
  });

  test("build stays on executor even after compaction removes edits", () => {
    const state: FusionState = { phase: "build" };
    const routed = routeFusion(request({ state, messages: [] }), models);
    expect(routed.model).toBe(executor);
    expect(routed.state).toBe(state);
  });

  test("planner failure retries on executor and persists build", () => {
    const routed = routeFusion(request({ reason: "retry", failed: failed() }), models);
    expect(routed).toMatchObject({ model: executor, state: { phase: "build" } });
    expect(routeFusion(request({ state: routed.state }), models).model).toBe(executor);
  });

  test("other retries stay on the failed physical model and thinking level", () => {
    const state: FusionState = { phase: "build" };
    const routed = routeFusion(request({ reason: "retry", state, thinkingLevel: "high", failed: failed(executor) }), models);
    expect(routed).toEqual({ model: executor, thinkingLevel: "off", state });
    const other = model("another-model");
    expect(routeFusion(request({ reason: "retry", failed: failed(other) }), models).model).toBe(other);
  });

  test("a new user message during retry backoff restarts planning on the planner", () => {
    const assistant = { role: "assistant", content: [] } as unknown as Request["messages"][number];
    const messages = [user, assistant, { ...user, content: "new request", timestamp: 4 }];
    const routed = routeFusion(request({ reason: "retry", state: { phase: "build" }, failed: failed(executor), messages }), models);
    expect(routed).toMatchObject({ model: planner, state: { phase: "plan" } });
    const fallback = routeFusion(request({ reason: "retry", state: { phase: "build" }, failed: failed(executor), messages }), { ...models, planner: undefined });
    expect(fallback).toMatchObject({ model: defaultModel, state: { phase: "plan" } });
  });

  test("retry without a failed physical route uses executor", () => {
    expect(routeFusion(request({ reason: "retry" }), models)).toMatchObject({ model: executor, state: { phase: "build" } });
  });

  test("direct requests use executor without altering branch state", () => {
    expect(routeFusion(request({ reason: "direct", state: { phase: "plan" } }), models)).toEqual({ model: executor, thinkingLevel: "off", state: undefined });
  });

  for (const missing of ["planner", "executor"] as const) {
    test.each(["user", "continuation", "retry", "direct"] as const)(`missing ${missing}: %s uses the catalog default`, (reason) => {
      expect(routeFusion(request({ reason, failed: failed() }), { ...models, [missing]: undefined }).model).toBe(defaultModel);
    });
  }

  test("routing is branch-local and does not mutate its inputs", () => {
    const planning = Object.freeze({ phase: "plan" } as const);
    const building = Object.freeze({ phase: "build" } as const);
    expect(routeFusion(request({ state: building }), models).model).toBe(executor);
    expect(routeFusion(request({ state: planning }), models).model).toBe(planner);
    expect(planning.phase).toBe("plan");
  });
});
