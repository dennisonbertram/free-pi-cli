import type { InlineExtension, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { PROVIDER_NAME } from "./provider";

/** Legacy id: still registered so saved settings and sessions resolve, but hidden from the picker. */
export const FUSION_ID = "fusion";
/** pi's picker rows show the model id (not the name), so the picker entry's id carries the emoji. */
export const FUSION_PICKER_ID = "🧨 fusion";
export const FUSION_NAME = "🧨 Fusion · DeepSeek Pro plans, Flash builds";
const FUSION_FALLBACK_NAME = "🧨 Fusion · Argon plans, DeepSeek builds";
export const FUSION_PLANNER_ID = "deepseek-v4-pro";
export const FUSION_EXECUTOR_ID = "deepseek-v4-flash";
// Used only when the server catalog has no V4 Pro row (older server).
export const FUSION_FALLBACK_PLANNER_ID = "gemini-4-argon-flex";

export interface FusionIds {
  planner: string;
  executor: string;
}

/**
 * Pick the Fusion planner/executor: the server's ids when both are in the catalog the
 * CLI registers, else the built-in defaults, with the planner falling back to Argon Flex
 * when a server predates the V4 Pro catalog row.
 */
export function resolveFusionIds(catalogIds: string[], server?: FusionIds): FusionIds {
  const has = (id: string) => catalogIds.includes(id);
  if (server && has(server.planner) && has(server.executor)) return server;
  return { planner: has(FUSION_PLANNER_ID) ? FUSION_PLANNER_ID : FUSION_FALLBACK_PLANNER_ID, executor: FUSION_EXECUTOR_ID };
}

export interface FusionState {
  phase: "plan" | "build";
}

type FusionRequest = Pick<ModelRouteRequest<FusionState>, "reason" | "state" | "messages" | "failed" | "thinkingLevel">;
type PhysicalModel = ModelRoute<FusionState>["model"];

interface FusionModels {
  planner?: PhysicalModel;
  executor?: PhysicalModel;
  defaultModel: PhysicalModel;
}

function editedThisTurn(messages: FusionRequest["messages"]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") break;
    if (message.role === "toolResult" && (message.toolName === "edit" || message.toolName === "write") && !message.isError) {
      return true;
    }
  }
  return false;
}

/**
 * pi labels a request "retry" even when the user typed during backoff, and drops the failed
 * response from the context, so a user message newer than the failed response is new input.
 */
function hasNewUserInput(request: FusionRequest): boolean {
  const failedAt = request.failed?.message.timestamp;
  if (failedAt === undefined) return false;
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]!;
    if (message.role === "assistant") return false;
    if (message.role === "user") return message.timestamp > failedAt;
  }
  return false;
}

/** Selects only; pi owns dispatch, retries, and branch-local state persistence. */
export function routeFusion(request: FusionRequest, models: FusionModels): ModelRoute<FusionState> {
  const phase = request.state?.phase ?? "plan";
  const restartPlan = request.reason === "user" || (request.reason === "retry" && hasNewUserInput(request));
  const route = (model: PhysicalModel, nextPhase = phase): ModelRoute<FusionState> => ({
    model,
    thinkingLevel: request.thinkingLevel,
    state: request.reason === "direct" ? undefined : request.state?.phase === nextPhase ? request.state : { phase: nextPhase },
  });

  if (!models.planner || !models.executor) {
    return route(models.defaultModel, restartPlan ? "plan" : phase);
  }
  switch (request.reason) {
    case "user":
      return route(models.planner, "plan");
    case "direct":
      return route(models.executor);
    case "retry": {
      if (restartPlan) return route(models.planner, "plan");
      const failed = request.failed;
      if (!failed || (failed.model.provider === PROVIDER_NAME && failed.model.id === models.planner?.id)) {
        return route(models.executor, "build");
      }
      return { ...route(failed.model), thinkingLevel: failed.thinkingLevel ?? request.thinkingLevel };
    }
    case "continuation":
      return phase === "build" || editedThisTurn(request.messages)
        ? route(models.executor, "build")
        : route(models.planner, "plan");
  }
}

export function createFusionExtension(defaultModelId: string, ids: FusionIds = resolveFusionIds([])): InlineExtension {
  const name = ids.planner === FUSION_PLANNER_ID && ids.executor === FUSION_EXECUTOR_ID ? FUSION_NAME
    : ids.planner === FUSION_FALLBACK_PLANNER_ID ? FUSION_FALLBACK_NAME : "🧨 Fusion";
  return {
    name: "free-pi-fusion",
    factory: (pi) => {
      for (const id of [FUSION_PICKER_ID, FUSION_ID]) {
        pi.registerVirtualModel<FusionState>({
          provider: PROVIDER_NAME,
          id,
          name,
          input: ["text"],
          route: (request, ctx) => routeFusion(request, {
            planner: ctx.modelRegistry.find(PROVIDER_NAME, ids.planner),
            executor: ctx.modelRegistry.find(PROVIDER_NAME, ids.executor),
            // The provider extension registers the first catalog row before Fusion.
            defaultModel: ctx.modelRegistry.find(PROVIDER_NAME, defaultModelId)!,
          }),
        });
      }
    },
  };
}
