import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearJwt, loadJwt, saveJwt } from "../src/credentials";
import { runLogout, type LogoutDeps } from "../src/logout";

function tempCredentialsPath(): string {
  return join(mkdtempSync(join(tmpdir(), "free-pi-cli-logout-")), "credentials.json");
}

/** Real credential fns against a temp dir (the firstrun.test approach) plus a log recorder. */
function realDeps(credentialsPath: string): LogoutDeps & { logs: string[] } {
  const logs: string[] = [];
  return { credentialsPath, loadJwt, clearJwt, log: (m) => logs.push(m), logs };
}

describe("runLogout — purely local, always exits 0", () => {
  test("stored token -> file removed, 'Logged out' names the path, next loadJwt is null", async () => {
    const credentialsPath = tempCredentialsPath();
    await saveJwt(credentialsPath, "jwt-abc");
    const deps = realDeps(credentialsPath);

    const code = await runLogout(deps);

    expect(code).toBe(0);
    expect(existsSync(credentialsPath)).toBe(false);
    expect(await loadJwt(credentialsPath)).toBeNull();
    expect(deps.logs.join("\n")).toContain("Logged out");
    expect(deps.logs.join("\n")).toContain(credentialsPath);
  });

  test("no stored token -> still exits 0 and says already logged out (idempotent)", async () => {
    const deps = realDeps(tempCredentialsPath());

    const code = await runLogout(deps);

    expect(code).toBe(0);
    expect(deps.logs.join("\n")).toContain("Already logged out");
  });

  test("corrupt credentials file -> removed anyway (loadJwt reads it as null, clearJwt is unconditional)", async () => {
    const credentialsPath = tempCredentialsPath();
    await writeFile(credentialsPath, "not json at all");

    const code = await runLogout(realDeps(credentialsPath));

    expect(code).toBe(0);
    expect(existsSync(credentialsPath)).toBe(false);
  });

  test("logout twice in a row -> second run is a clean no-op, not an error", async () => {
    const credentialsPath = tempCredentialsPath();
    await saveJwt(credentialsPath, "jwt-abc");

    expect(await runLogout(realDeps(credentialsPath))).toBe(0);
    const second = realDeps(credentialsPath);
    expect(await runLogout(second)).toBe(0);
    expect(second.logs.join("\n")).toContain("Already logged out");
  });
});
