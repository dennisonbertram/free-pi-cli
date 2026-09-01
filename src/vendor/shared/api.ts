import { z } from "zod";

// ---- POST /v1/chat/completions ----
// OpenAI-compatible chat completion request. Permissive passthrough so
// client-supplied fields we don't police (tools, tool_choice, etc.) survive
// to the upstream forward.

export const ChatMessageSchema = z
  .object({
    role: z.string(),
    content: z.unknown().optional(),
  })
  .passthrough();

export const ChatCompletionRequestSchema = z
  .object({
    model: z.string().optional(),
    messages: z.array(ChatMessageSchema).min(1),
    stream: z.boolean().optional(),
    max_tokens: z.number().optional(),
    temperature: z.number().optional(),
    tools: z.array(z.unknown()).optional(),
  })
  .passthrough();

export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;

// ---- Auth: GitHub device flow ----

export const GithubDeviceResponseSchema = z.object({
  session_id: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  interval: z.number(),
});
export type GithubDeviceResponse = z.infer<typeof GithubDeviceResponseSchema>;

export const AuthTokenRequestSchema = z.object({
  session_id: z.string(),
});
export type AuthTokenRequest = z.infer<typeof AuthTokenRequestSchema>;

export const AuthTokenPendingSchema = z.object({
  status: z.literal("pending"),
  /** Seconds to wait before the next poll. Present only when GitHub said slow_down. */
  retry_after: z.number().optional(),
});
export const AuthTokenIssuedSchema = z.object({ token: z.string() });
export const AuthTokenConsentRequiredSchema = z.object({
  code: z.literal("consent_required"),
  message: z.string(),
});

export const AuthTokenResponseSchema = z.union([
  AuthTokenPendingSchema,
  AuthTokenIssuedSchema,
  AuthTokenConsentRequiredSchema,
]);
export type AuthTokenResponse = z.infer<typeof AuthTokenResponseSchema>;

export const AuthConsentRequestSchema = z.object({
  session_id: z.string(),
  consent_version: z.string(),
});
export type AuthConsentRequest = z.infer<typeof AuthConsentRequestSchema>;

// ---- GET /me, GET /me/stats (#17, #22) ----

export const AccountTierSchema = z.enum(["new", "young", "established"]);
export type AccountTier = z.infer<typeof AccountTierSchema>;

export const MeResponseSchema = z.object({
  user_id: z.string(),
  handle: z.string(),
  remaining_usd_today: z.number(),
  cap_usd_today: z.number(),
  tier: AccountTierSchema,
  /** #229: purchased-usage balance in USD (display-only). Additive; old CLIs ignore it. */
  credit_usd: z.number(),
  /** #224: server-owned plain-text line for the meter widget; present only when free budget AND credit are both exhausted. Rendered as text, never interpreted. */
  notice: z.string().optional(),
  /** #224: a fresh short-lived buy-page URL (what the /buy-credits tool opens). Never cache it. */
  buy_url: z.string().optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

export const MeStatsResponseSchema = z.object({
  user_id: z.string(),
  handle: z.string(),
  tier: AccountTierSchema,
  cap_usd_today: z.number(),
  spent_usd_today: z.number(),
  remaining_usd_today: z.number(),
  /** #229: purchased-usage balance in USD (display-only). */
  credit_usd: z.number(),
  request_count_today: z.number(),
  prompt_tokens_today: z.number(),
  completion_tokens_today: z.number(),
  lifetime: z.object({
    spent_usd: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    request_count: z.number(),
  }),
});
export type MeStatsResponse = z.infer<typeof MeStatsResponseSchema>;

// ---- Ads ----

export const AdSlotSchema = z.enum(["banner", "inline"]);
export type AdSlot = z.infer<typeof AdSlotSchema>;

export const AdCreativeSchema = z.object({
  headline: z.string(),
  body: z.string(),
  cta: z.string(),
  accent: z.string(),
});
export type AdCreative = z.infer<typeof AdCreativeSchema>;

export const AdNextQuerySchema = z.object({
  slot: AdSlotSchema,
});
export type AdNextQuery = z.infer<typeof AdNextQuerySchema>;

// 200 response body; a 204 (no active ad) carries no body.
export const AdNextResponseSchema = z.object({
  ad_id: z.string(),
  click_token: z.string(),
  creative: AdCreativeSchema,
  click_url: z.string(),
});
export type AdNextResponse = z.infer<typeof AdNextResponseSchema>;

export const AdImpressionRequestSchema = z.object({
  ad_id: z.string(),
  click_token: z.string(),
});
export type AdImpressionRequest = z.infer<typeof AdImpressionRequestSchema>;

// ---- Admin ----

export const AdminAdRequestSchema = z.object({
  slot: AdSlotSchema,
  creative: AdCreativeSchema,
  link_url: z
    .string()
    .url()
    .refine((v) => v.startsWith("https://"), "link_url must be https"),
  priority: z.number(),
  active: z.boolean(),
  bid_usd: z.number().optional(),
  budget_usd: z.number().optional(),
});
export type AdminAdRequest = z.infer<typeof AdminAdRequestSchema>;

export const AdminStatsPeriodSchema = z.object({
  spend_usd: z.number(),
  active_users: z.number(),
  impressions: z.number(),
  clicks: z.number(),
  /** Trace count per provider that actually served the request. */
  by_provider: z.record(z.string(), z.number()),
});

export const AdminStatsResponseSchema = z.object({
  today: AdminStatsPeriodSchema,
  yesterday: AdminStatsPeriodSchema,
});
export type AdminStatsResponse = z.infer<typeof AdminStatsResponseSchema>;

// ---- GET /client-version (#37) ----

export const ClientVersionResponseSchema = z.object({
  min: z.string(),
  latest: z.string(),
  // Trial display (optional): the active model name the CLI shows, and a
  // one-line notice printed at startup (e.g. a data-handling disclosure during
  // a free-model trial). Both server-driven + env-controlled so enabling a
  // trial is a pure box-env toggle — no CLI release. Unset preserves today.
  model: z.string().optional(),
  notice: z.string().optional(),
  // #140: the selectable model catalog. Each entry's `id` is what the CLI sends
  // as the request model (the server resolves it against model_catalog); `name`
  // is the picker label. Optional so a plain response still parses — the CLI
  // falls back to the single `model` field.
  models: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
});
export type ClientVersionResponse = z.infer<typeof ClientVersionResponseSchema>;

// ---- POST /session/reset (0.2.6: /close-other-session) ----

export const SessionResetResponseSchema = z.object({
  // true = a stuck lease was cleared; false = nothing was held (already free).
  released: z.boolean(),
});
export type SessionResetResponse = z.infer<typeof SessionResetResponseSchema>;
