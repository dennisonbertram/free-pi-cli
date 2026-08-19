// `free-pi-cli logout`: remove the stored JWT so the next run repeats
// first-run consent + GitHub sign-in (consent lives server-side, keyed to
// the sign-in — clearing the local token is what re-triggers both).
//
// Purely local by design: the client API contract (vendor/shared) has no
// revoke endpoint, so the 90-day JWT itself stays valid server-side until
// expiry — deleting the only copy on disk is the entire operation, and it
// keeps logout working offline. Deps are injected like run()'s, so tests
// never touch a real home directory.
export interface LogoutDeps {
  credentialsPath: string;
  loadJwt: (credentialsPath: string) => Promise<string | null>;
  clearJwt: (credentialsPath: string) => Promise<void>;
  log: (message: string) => void;
}

export async function runLogout(deps: LogoutDeps): Promise<number> {
  // loadJwt only says whether a *usable* token exists (missing, malformed,
  // and empty files all read as null) — clearJwt force-removes the file
  // either way, so a corrupt credentials file is cleaned up too.
  const hadToken = (await deps.loadJwt(deps.credentialsPath)) !== null;
  await deps.clearJwt(deps.credentialsPath);
  deps.log(
    hadToken
      ? `Logged out: removed ${deps.credentialsPath}. The next run signs in again.`
      : "Already logged out — no stored sign-in token.",
  );
  return 0;
}
