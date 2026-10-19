// What ad is on screen right now, shared by the banner and inline renderers.
// Gravity's publisher rule: no other ad may be visible beside a Gravity ad,
// so each renderer checks this before showing an own ad and clears the other
// widget when a Gravity ad takes over. UI state only; nothing here is model-visible.
export interface AdScreen {
  banner?: "gravity" | "own";
  inline?: "gravity" | "own";
  clearBanner?: () => void;
  clearInline?: () => void;
}
