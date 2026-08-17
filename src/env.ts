export const DEFAULT_BASE_URL = "https://api.freepi.ai";

export function resolveBaseUrl(env: Record<string, string | undefined> = process.env): string {
  return env.FREEPI_BASE_URL || DEFAULT_BASE_URL;
}
