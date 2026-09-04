// KTD4/KTD6: the free-pi guide as a read-only pi tool, mirroring
// usage-tool.ts's shape (own module, empty parameter schema, no event
// handlers, never throws, never touches the network or filesystem).
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { FREE_PI_DOCS } from "./docs";

// #28-style: the one custom tool name needed by pi-launch.ts's tool-guard
// allowlist and the SDK's own strict `tools` allowlist so this tool isn't
// blocked as if it were rogue.
export const DOCS_TOOL_NAME = "free_pi_docs";

const PARAMS = Type.Object({});

export function createDocsToolExtension(): InlineExtension {
  return {
    name: "free-pi-docs-tool",
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: DOCS_TOOL_NAME,
        label: "About free-pi",
        description: "Returns the built-in free-pi guide. Read-only, takes no arguments, makes no network calls.",
        promptSnippet: "Explain free-pi itself: what it is, how the free allowance and ads work, credits, and the free-pi slash commands",
        parameters: PARAMS,
        async execute() {
          return {
            content: [{ type: "text" as const, text: FREE_PI_DOCS }],
            details: { ok: true },
          };
        },
      });
    },
  };
}
