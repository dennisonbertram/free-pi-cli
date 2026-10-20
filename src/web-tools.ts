// web_search and docs_lookup: thin clients for the server's /tools/* routes.
// The server runs the search / Context7 call and meters it against the user's
// daily allowance; this file only POSTs with the user's JWT and returns text.
// Errors come back as text, never thrown. cost_usd stays in `details`, out of
// model context. Outside packages/pi-ads on the same grounds as usage-tool.ts.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const WEB_SEARCH_TOOL_NAME = "web_search";
export const DOCS_LOOKUP_TOOL_NAME = "docs_lookup";

export interface CreateWebToolsOptions {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}

const COST_GUIDELINE = "Each web_search or docs_lookup call costs part of the user's daily allowance; one or two well-aimed calls usually suffice.";

export const DOCS_LOOKUP_GUIDELINES = [
  "Use docs_lookup before writing or fixing code against a third-party library, framework, SDK or API whose exact signature or config you are not sure of, and whenever an import, method or option you used turns out not to exist.",
  'Pass the package name as `library` (e.g. "next.js", "prisma", "@tanstack/react-query") and one specific question as `query` (e.g. "configure middleware matcher for API routes"), not a bare topic. Reuse the returned `library_id` for follow-up lookups on the same library.',
  COST_GUIDELINE,
];

export const WEB_SEARCH_GUIDELINES = [
  "Use web_search for things that change or are newer than your knowledge: release notes, current versions, exact error messages you cannot explain from the code, service status, and pages the user links or mentions. Prefer docs_lookup for library API docs, and read/grep for anything in the local project.",
  "Write a specific query the way you would type it into a search engine (include the product name, the version and the exact error text). Read the returned page text before searching again, and do not repeat a query that already returned results. Cite the URLs you relied on in your answer.",
  COST_GUIDELINE,
];

const ERROR_TEXT: Record<string, string | ((label: string) => string)> = {
  daily_cap: "The user's daily free usage is used up. Do not retry; tell the user and continue without this tool.",
  rolling_cap: "The user's short-term usage limit is reached. Do not retry; continue without this tool.",
  rate_limited: "Too many calls right now. Wait for the current call to finish, and do not call again in this turn unless needed.",
  not_found: (library) => `No documentation library matched "${library}". Retry once with the package's exact name, or use web_search.`,
  not_configured: "This tool is not available on this server. Do not call it again in this session.",
  upstream_error: "The search provider failed. You may retry once.",
};

type Out = { text: string; details: unknown };

async function post(opts: CreateWebToolsOptions, path: string, body: unknown, label: string, signal: AbortSignal | undefined): Promise<{ ok: true; data: any } | { ok: false; text: string }> {
  try {
    const timeout = AbortSignal.timeout(30_000);
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await opts.getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.ok) return { ok: true, data: await res.json() };
    const err = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    const mapped = ERROR_TEXT[err.code ?? ""];
    if (mapped) return { ok: false, text: typeof mapped === "function" ? mapped(label) : mapped };
    return { ok: false, text: `Request failed (HTTP ${res.status}): ${err.message ?? "no message"}` };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return { ok: false, text: "Request timed out after 30 seconds." };
    return { ok: false, text: `Request failed: ${String(e)}` };
  }
}

const done = (o: Out) => ({ content: [{ type: "text" as const, text: o.text }], details: o.details });

export function createWebToolsExtension(opts: CreateWebToolsOptions): InlineExtension {
  return {
    name: "free-pi-web-tools",
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: WEB_SEARCH_TOOL_NAME,
        label: "Web Search",
        description:
          "Search the web and return a numbered list of results, each with title, URL, publish date and the page text. Use it for current or recent information that your training data may lack. Each call uses part of the user's daily allowance.",
        promptSnippet: "Search the web for current information (counts against the user's daily allowance)",
        promptGuidelines: WEB_SEARCH_GUIDELINES,
        parameters: Type.Object({
          query: Type.String({ minLength: 1, maxLength: 500, description: 'Specific query as you would type it into a search engine, e.g. "vite 6 release notes breaking changes"'  }),
          num_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "1-10, default 5; use 3 for a quick fact, 8-10 for a survey" })),
        }),
        async execute(_id, params, signal) {
          const r = await post(opts, "/tools/web-search", params, "", signal);
          if (!r.ok) return done({ text: r.text, details: { ok: false } });
          const results = (r.data.results ?? []) as Array<{ title: string; url: string; published_date: string | null; text: string }>;
          const text = results.length
            ? `Web results for "${params.query}":\n\n` + results.map((x, i) => `${i + 1}. ${x.title}\n${x.url}${x.published_date ? `\nPublished: ${x.published_date}` : ""}\n${x.text}`).join("\n\n")
            : `No results for "${params.query}". Try a broader or differently worded query.`;
          return done({ text, details: { ok: true, cost_usd: r.data.cost_usd } });
        },
      });
      pi.registerTool({
        name: DOCS_LOOKUP_TOOL_NAME,
        label: "Docs Lookup",
        description:
          "Look up current documentation for a third-party library, framework or API. Returns the matching library's title and library_id, then documentation text relevant to your query. Use it instead of relying on memory for exact signatures and options. Each call uses part of the user's daily allowance.",
        promptSnippet: "Look up library/framework documentation before relying on memory (counts against the user's daily allowance)",
        promptGuidelines: DOCS_LOOKUP_GUIDELINES,
        parameters: Type.Object({
          library: Type.String({ minLength: 1, maxLength: 200, description: 'Package or library name, e.g. "next.js", "prisma", "@tanstack/react-query"' }),
          query: Type.String({ minLength: 1, maxLength: 500, description: 'One specific question, e.g. "configure middleware matcher for API routes"'  }),
          library_id: Type.Optional(Type.String({ description: 'The library_id printed by an earlier docs_lookup, e.g. /vercel/next.js; skips the name search' })),
        }),
        async execute(_id, params, signal) {
          const r = await post(opts, "/tools/docs", params, params.library, signal);
          if (!r.ok) return done({ text: r.text, details: { ok: false } });
          const d = r.data as { library_id: string; title: string; docs: string; cost_usd: string };
          return done({ text: `${d.title} (library_id: ${d.library_id})\n\n${d.docs}`, details: { ok: true, cost_usd: d.cost_usd } });
        },
      });
    },
  };
}
