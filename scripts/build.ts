// Cross-platform build, replacing the posix-only `rm -rf … && bun build … &&
// chmod +x` pipeline in package.json — the reason CI's build gate skipped
// Windows (release-checklist note from the #2 merge review). Same inputs,
// same outputs: dist/index.js with the shebang banner plus split chunks,
// executable on posix. chmod is skipped on win32, where the concept doesn't
// exist and npm's bin shims don't need it.
import { chmodSync, rmSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });

const result = await Bun.build({
  entrypoints: ["src/index.ts"],
  outdir: "dist",
  target: "node",
  splitting: true,
  external: ["@earendil-works/pi-coding-agent"],
  banner: "#!/usr/bin/env node",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

if (process.platform !== "win32") chmodSync("dist/index.js", 0o755);
