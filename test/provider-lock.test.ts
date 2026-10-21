import { afterEach, describe, expect, test } from "bun:test";
import { resolveFreePiScope } from "../src/provider-lock";
import { FUSION_PICKER_ID as FUSION_ID } from "../src/fusion";

const FREE_PI_MODEL = { provider: "free-pi", id: "deepseek/deepseek-v4-flash" };

// Fake ModelRuntime.getModel: returns the free-pi model, undefined for anything else.
function finder() {
  return {
    getModel: (provider: string, id: string) =>
      provider === FREE_PI_MODEL.provider && id === FREE_PI_MODEL.id ? (FREE_PI_MODEL as never) : undefined,
  };
}

afterEach(() => {
  delete process.env.FREEPI_KEEP_ENV_PROVIDERS;
});

describe("resolveFreePiScope", () => {
  test("includes registered Fusion once, without exposing other providers", () => {
    const fusion = { provider: "free-pi", id: FUSION_ID };
    const runtime = { getModel: (provider: string, id: string) =>
      provider === "free-pi" && id === FUSION_ID ? fusion as never : finder().getModel(provider, id) };
    expect(resolveFreePiScope(runtime, "free-pi", [FREE_PI_MODEL.id, FUSION_ID], {}))
      .toEqual([{ model: fusion as never }, { model: FREE_PI_MODEL as never }]);
    expect(resolveFreePiScope(runtime, "free-pi", [FREE_PI_MODEL.id], { FREEPI_KEEP_ENV_PROVIDERS: "1" }))
      .toEqual([]);
  });

  test("scopes the picker to just the free-pi model", () => {
    const scope = resolveFreePiScope(finder(), "free-pi", ["deepseek/deepseek-v4-flash"], {});
    expect(scope).toEqual([{ model: FREE_PI_MODEL as never }]);
  });

  test("FREEPI_KEEP_ENV_PROVIDERS opts out — empty scope means the picker shows everything", () => {
    const scope = resolveFreePiScope(finder(), "free-pi", ["deepseek/deepseek-v4-flash"], {
      FREEPI_KEEP_ENV_PROVIDERS: "1",
    });
    expect(scope).toEqual([]);
  });

  test("fails open (empty scope) if the free-pi model isn't registered yet", () => {
    const scope = resolveFreePiScope(finder(), "free-pi", ["some-other-model"], {});
    expect(scope).toEqual([]);
  });

  test("defaults to process.env when no env is passed", () => {
    process.env.FREEPI_KEEP_ENV_PROVIDERS = "1";
    expect(resolveFreePiScope(finder(), "free-pi", ["deepseek/deepseek-v4-flash"])).toEqual([]);
  });
});
