// generate_image: thin client for the server's POST /tools/image. The server
// calls the image model and meters the cost against the user's daily allowance;
// this file POSTs with the user's JWT, saves the returned image under
// <cwd>/images/, and gives the model only the file path (never the bytes).
// Errors come back as text, never thrown. cost_usd stays in `details`, out of
// model context. Outside packages/pi-ads on the same grounds as web-tools.ts.
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

export const IMAGE_TOOL_NAME = "generate_image";

export interface CreateImageToolOptions {
  baseUrl: string;
  getToken: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
  /** Project directory images/ is created in. Defaults to process.cwd(). */
  cwd?: string;
}

const MAX_BYTES = 8 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export const IMAGE_GUIDELINES = [
  "Use generate_image only when the user asks for an image, mockup, icon, illustration or other visual asset. Do not call it for diagrams you can write as code, SVG or ASCII.",
  "Make one call per asset. Put the style, any exact text to render, and the composition in the prompt, and pick aspect_ratio to suit the use (16:9 for banners, 1:1 for icons).",
  "You cannot see the generated image. The tool saves it to a file and returns the relative path; refer to that path in code, docs or your answer, and tell the user you could not check how it looks.",
  "Each image uses part of the user's daily allowance, so do not regenerate unless the user asks.",
];

const ERROR_TEXT: Record<string, string> = {
  daily_cap: "The user's free allowance for today is used up. Do not retry. Tell the user they can get credits at freepi.ai/extra-credits, and continue without this tool.",
  rolling_cap: "The user's short-term usage limit is reached. Do not retry; continue without this tool.",
  rate_limited: "Too many image requests right now. Do not call generate_image again in this turn unless the user asks.",
  not_configured: "Image generation is not available on this server. Do not call generate_image again in this session.",
  upstream_error: "The image provider failed. You may retry once.",
  account_review: "This account is under review, so image generation is disabled. Do not retry; tell the user and continue without it.",
  content_rejected: "The image provider rejected this prompt. Do not retry the same prompt; tell the user and offer to reword it.",
};

type Result = { ok: true; data: any } | { ok: false; text: string };

async function post(opts: CreateImageToolOptions, body: unknown, signal: AbortSignal | undefined): Promise<Result> {
  try {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const res = await (opts.fetchImpl ?? fetch)(`${opts.baseUrl}/tools/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await opts.getToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (res.ok) return { ok: true, data: await res.json() };
    const j = (await res.json().catch(() => ({}))) as { code?: string; message?: string; error?: { code?: string; message?: string } };
    const code = j.error?.code ?? j.code ?? "";
    const mapped = ERROR_TEXT[code];
    if (mapped) return { ok: false, text: mapped };
    return { ok: false, text: `Request failed (HTTP ${res.status}): ${j.error?.message ?? j.message ?? "no message"}` };
  } catch (e) {
    if (e instanceof Error && e.name === "TimeoutError") return { ok: false, text: "Image generation timed out after 120 seconds." };
    return { ok: false, text: `Request failed: ${String(e)}` };
  }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 40).replace(/-+$/, "") || "image";
}

const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", webp: "image/webp" };
// Exactly the names execute() writes: images/<slug>-<6 hex>.<ext>.
const SAFE_PATH = /^images\/[a-z0-9-]+-[0-9a-f]{6}\.(png|jpg|webp)$/;
const MAX_CELLS_W = 60;
const MAX_CELLS_H = 40;

/**
 * UI-only rendering of a tool result: a short "Saved" line, plus the image
 * itself when the terminal supports inline images (pi-tui detection: Kitty,
 * Ghostty, WezTerm, Warp, iTerm2; never under tmux/screen). The bytes are read
 * back from the saved file, so they never enter `content` (model context) or
 * the session log. Any failure falls back to the text line alone.
 */
export function renderImageResult(
  res: { content: Array<{ type: string; text?: string }>; details?: unknown },
  ctx: { cwd: string; showImages: boolean; state: any },
  theme: { fg: (c: any, s: string) => string },
) {
  const d = res.details as { ok?: boolean; path?: string } | undefined;
  const text = d?.ok && d.path ? `Saved image to ${d.path}` : (res.content.find((c) => c.type === "text")?.text ?? "");
  const textBlock = new Text(theme.fg("toolOutput", text), 0, 0);
  let img: Image | undefined;
  if (d?.ok && d.path && SAFE_PATH.test(d.path) && ctx.showImages && getCapabilities().images) {
    try {
      const st = ctx.state as { path?: string; img?: Image };
      if (st.path !== d.path) {
        const ext = d.path.split(".").pop() ?? "";
        const mime = Object.hasOwn(MIME, ext) ? MIME[ext] : undefined;
        const file = join(ctx.cwd, d.path);
        st.path = d.path;
        st.img = mime && statSync(file).size <= MAX_BYTES ? new Image(readFileSync(file).toString("base64"), mime, { fallbackColor: (s) => theme.fg("toolOutput", s) }, { maxWidthCells: MAX_CELLS_W, maxHeightCells: MAX_CELLS_H }) : undefined;
      }
      img = st.img;
    } catch { /* file gone or unreadable: text line only */ }
  }
  return {
    render: (w: number) => (img ? [...textBlock.render(w), "", ...img.render(w)] : textBlock.render(w)),
    invalidate: () => { textBlock.invalidate(); img?.invalidate(); },
  };
}

const done = (text: string, details: unknown) => ({ content: [{ type: "text" as const, text }], details });
const fail = (text: string) => done(text, { ok: false });

export function createImageToolExtension(opts: CreateImageToolOptions): InlineExtension {
  return {
    name: "free-pi-image-tool",
    factory(pi: ExtensionAPI) {
      pi.registerTool({
        name: IMAGE_TOOL_NAME,
        label: "Generate Image",
        description:
          "Generate one image from a text prompt and save it as a file under images/ in the project. Returns the file path; you cannot see the image. Use it only when the user asks for an image, mockup, icon or illustration. Each call uses part of the user's daily allowance.",
        promptSnippet: "Generate an image file from a prompt when the user asks for one (counts against the user's daily allowance)",
        promptGuidelines: IMAGE_GUIDELINES,
        parameters: Type.Object({
          prompt: Type.String({ minLength: 1, maxLength: 1000, description: "What to draw: subject, style, any exact text to render, and composition" }),
          aspect_ratio: Type.Optional(Type.Union([Type.Literal("1:1"), Type.Literal("16:9"), Type.Literal("9:16"), Type.Literal("4:3"), Type.Literal("3:2")], { description: "Default 1:1" })),
          name: Type.Optional(Type.String({ maxLength: 60, description: "Short file name hint, e.g. hero-banner; used only for the saved file's name" })),
        }),
        renderResult: (res, _opts, theme, ctx) => renderImageResult(res, ctx, theme),
        async execute(_id, params, signal) {
          const r = await post(opts, { prompt: params.prompt, ...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}) }, signal);
          if (!r.ok) return fail(r.text);
          const d = r.data as { image_b64: string; media_type: string; cost_usd: string; model: string };
          const ext = EXT[d.media_type];
          if (!ext) return fail(`The server returned an unsupported image type (${d.media_type}). Nothing was saved.`);
          const buf = Buffer.from(d.image_b64 ?? "", "base64");
          if (buf.length === 0) return fail("The server returned an empty image. Nothing was saved.");
          if (buf.length > MAX_BYTES) return fail("The generated image was too large to save (over 8 MB). Nothing was saved.");
          const rel = `images/${slug(params.name ?? params.prompt)}-${randomBytes(3).toString("hex")}.${ext}`;
          try {
            await mkdir(join(opts.cwd ?? process.cwd(), "images"), { recursive: true });
            const fh = await open(join(opts.cwd ?? process.cwd(), rel), "wx");
            try { await fh.writeFile(buf); } finally { await fh.close(); }
          } catch (e) {
            return fail(`Could not save the image: ${String(e)}`);
          }
          return done(
            `Saved image to ${rel} (${ext}, ${buf.length} bytes). You cannot see the image; reference this path in your answer or code, and tell the user you could not check how it looks.`,
            { ok: true, path: rel, cost_usd: d.cost_usd, model: d.model },
          );
        },
      });
    },
  };
}
