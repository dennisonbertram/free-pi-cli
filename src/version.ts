// #37: the CLI's own version, read from package.json — bun inlines JSON
// imports at bundle time, so this is a build-time constant with no runtime
// fallback needed (package.json is always present in this workspace/bundle).
import pkg from "../package.json";

export const CLI_VERSION: string = pkg.version;
