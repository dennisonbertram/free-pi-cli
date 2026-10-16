import type { InlineExtension, ModelRoute, ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { PROVIDER_NAME } from "./provider";

export const FUSION_ID = "fusion";
export const FUSION_NAME = "Fusion · Argon plans, DeepSeek builds";
export const FUSION_PLANNER_ID = "gemini-4-argon-flex";
export const FUSION_EXECUTOR_ID = "deepseek-v4-flash";

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
      if (!failed || (failed.model.provider === PROVIDER_NAME && failed.model.id === FUSION_PLANNER_ID)) {
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

export function createFusionExtension(defaultModelId: string): InlineExtension {
  return {
    name: "free-pi-fusion",
    factory: (pi) => {
      pi.registerVirtualModel<FusionState>({
        provider: PROVIDER_NAME,
        id: FUSION_ID,
        name: FUSION_NAME,
        input: ["text"],
        route: (request, ctx) => routeFusion(request, {
          planner: ctx.modelRegistry.find(PROVIDER_NAME, FUSION_PLANNER_ID),
          executor: ctx.modelRegistry.find(PROVIDER_NAME, FUSION_EXECUTOR_ID),
          // The provider extension registers the first catalog row before Fusion.
          defaultModel: ctx.modelRegistry.find(PROVIDER_NAME, defaultModelId)!,
        }),
      });
    },
  };
}
