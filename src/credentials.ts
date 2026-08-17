import { mkdir, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { dirname } from "node:path";

interface StoredCredentials {
  token: string;
}

export async function loadJwt(credentialsPath: string): Promise<string | null> {
  try {
    const raw = await readFile(credentialsPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    return typeof parsed.token === "string" && parsed.token.length > 0 ? parsed.token : null;
  } catch {
    return null;
  }
}

export async function saveJwt(credentialsPath: string, token: string): Promise<void> {
  await mkdir(dirname(credentialsPath), { recursive: true });
  await writeFile(credentialsPath, JSON.stringify({ token } satisfies StoredCredentials), {
    mode: 0o600,
  });
  // Belt-and-suspenders: writeFile's `mode` only applies to newly created
  // files on some platforms/umasks. Force it so re-runs stay 0600 too.
  await chmod(credentialsPath, 0o600);
}

export async function clearJwt(credentialsPath: string): Promise<void> {
  await rm(credentialsPath, { force: true });
}
