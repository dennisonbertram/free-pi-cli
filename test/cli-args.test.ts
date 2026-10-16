import { describe, expect, test } from "bun:test";
import { HELP_TEXT, parseCliArgs, versionLine } from "../src/cli-args";
import { CLI_VERSION } from "../src/version";

describe("parseCliArgs — local command dispatch", () => {
  test("no args -> run (the agent flow, unchanged default)", () => {
    expect(parseCliArgs([])).toEqual({ kind: "run" });
  });

  test.each([["--help"], ["-h"], ["help"]])("%s -> help", (arg) => {
    expect(parseCliArgs([arg])).toEqual({ kind: "help" });
  });

  test.each([["--version"], ["-v"]])("%s -> version", (arg) => {
    expect(parseCliArgs([arg])).toEqual({ kind: "version" });
  });

  test("mcp passes every following argument through untouched", () => {
    expect(parseCliArgs(["mcp"])).toEqual({ kind: "mcp", args: [] });
    expect(parseCliArgs(["mcp", "add", "x", "--", "cmd", "a", "b"])).toEqual({
      kind: "mcp",
      args: ["add", "x", "--", "cmd", "a", "b"],
    });
    expect(parseCliArgs(["mcp", "list", "--json"])).toEqual({ kind: "mcp", args: ["list", "--json"] });
    expect(parseCliArgs(["mcp", "--help"])).toEqual({ kind: "mcp", args: ["--help"] });
  });

  test("HELP_TEXT lists the mcp command", () => {
    expect(HELP_TEXT).toContain("free-pi-cli mcp");
  });

  test("logout -> logout", () => {
    expect(parseCliArgs(["logout"])).toEqual({ kind: "logout" });
  });

  test("unrecognized first arg -> unknown (a typo must not silently start a token-burning agent session)", () => {
    expect(parseCliArgs(["loguot"])).toEqual({ kind: "unknown", arg: "loguot" });
  });

  test("trailing args after a valid command -> unknown, reporting the extra arg", () => {
    expect(parseCliArgs(["logout", "--force"])).toEqual({ kind: "unknown", arg: "--force" });
  });

  test("--session <id> -> run (value validation stays in run.ts)", () => {
    expect(parseCliArgs(["--session", "abc"])).toEqual({ kind: "run" });
  });

  test("bare --session -> run so run.ts prints its own missing-value message", () => {
    expect(parseCliArgs(["--session"])).toEqual({ kind: "run" });
  });

  test("--session <id> with extra trailing args -> unknown", () => {
    expect(parseCliArgs(["--session", "a", "b"])).toEqual({ kind: "unknown", arg: "b" });
  });
});

describe("help/version text", () => {
  test("help documents every command and the env overrides", () => {
    for (const needle of ["logout", "--session", "--version", "--help", "FREEPI_BASE_URL", "FREEPI_NO_AUTO_UPDATE"]) {
      expect(HELP_TEXT).toContain(needle);
    }
  });

  test("version line carries the real CLI_VERSION", () => {
    expect(versionLine()).toBe(`free-pi-cli ${CLI_VERSION}`);
  });
});
