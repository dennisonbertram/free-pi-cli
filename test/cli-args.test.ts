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

  test("logout -> logout", () => {
    expect(parseCliArgs(["logout"])).toEqual({ kind: "logout" });
  });

  test("unrecognized first arg -> unknown (a typo must not silently start a token-burning agent session)", () => {
    expect(parseCliArgs(["loguot"])).toEqual({ kind: "unknown", arg: "loguot" });
  });

  test("trailing args after a valid command -> unknown, reporting the extra arg", () => {
    expect(parseCliArgs(["logout", "--force"])).toEqual({ kind: "unknown", arg: "--force" });
  });

  test("--session <id> -> run: the gate must not eat the flag the intro and exit line advertise (run() owns its parsing)", () => {
    expect(parseCliArgs(["--session", "abc-123"])).toEqual({ kind: "run" });
  });

  test("--session with no value -> still run, so run()'s own 'Missing value for --session' message is the one users see", () => {
    expect(parseCliArgs(["--session"])).toEqual({ kind: "run" });
  });

  test("--session <id> <extra> -> unknown, reporting the extra arg (strictness preserved past the pair)", () => {
    expect(parseCliArgs(["--session", "abc-123", "stray"])).toEqual({ kind: "unknown", arg: "stray" });
  });
});

describe("help/version text", () => {
  test("help documents every command and the env overrides", () => {
    for (const needle of ["logout", "--version", "--help", "--session", "FREEPI_BASE_URL", "FREEPI_NO_AUTO_UPDATE"]) {
      expect(HELP_TEXT).toContain(needle);
    }
  });

  test("version line carries the real CLI_VERSION", () => {
    expect(versionLine()).toBe(`free-pi-cli ${CLI_VERSION}`);
  });
});
