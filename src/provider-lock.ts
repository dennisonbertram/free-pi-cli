import type { ScopedModel } from "@earendil-works/pi-coding-agent";

// Model-picker lock. pi shows every provider whose auth is configured — and it
// auto-discovers a *builtin* provider (openrouter, huggingface, openai,
// amazon-bedrock, google-vertex, …) for any matching credential in the
// environment. Picking one silently routes around free-pi (their key, their
// bill, no free model). Those providers are pi builtins, so they can't be
// unregistered; and their credentials are often dual-use (AWS/gcloud creds the
// agent's `bash` tool legitimately needs), so we won't delete env vars either.
//
// Instead we use pi's own model-scope: when a session's `scopedModels` is
// non-empty, the model picker, `/model`, and model-cycling show ONLY those
// models and ignore provider availability entirely (interactive-mode.js:449).
// It reads no env vars, so every credential stays intact for `bash`.
//
// FREEPI_KEEP_ENV_PROVIDERS=1 opts out — an empty scope means "show everything",
// so the user's own env/`/login` providers appear as before.

/** Minimal slice of ModelRuntime this needs — kept narrow so it's trivially testable. */
interface ModelFinder {
  getModel(provider: string, modelId: string): ScopedModel["model"] | undefined;
}

/**
 * The `scopedModels` to hand `createAgentSessionFromServices`: only the free-pi
 * catalog models (#140), so the picker shows exactly them and nothing the
 * user's env leaks. Empty (no scope → every provider shows) when
 * FREEPI_KEEP_ENV_PROVIDERS is set, or if none of the ids are registered yet
 * (fail open rather than a picker with zero models).
 */
export function resolveFreePiScope(
  modelRuntime: ModelFinder,
  providerName: string,
  modelIds: string[],
  env: Record<string, string | undefined> = process.env,
): ScopedModel[] {
  if (env.FREEPI_KEEP_ENV_PROVIDERS) return [];
  const scoped: ScopedModel[] = [];
  for (const id of modelIds) {
    const model = modelRuntime.getModel(providerName, id);
    if (model) scoped.push({ model });
  }
  return scoped;
}
