/**
 * Shared n8n endpoint configuration.
 * Per-module adapters override `webhook` to point at their own builder endpoint.
 */

export const N8N_BASE = 'https://foundryrelay.dedicated2.com';

export const N8N_ENDPOINTS = {
  authLogin:    `${N8N_BASE}/webhook/oauth/patreon/login`,
  authPoll:     `${N8N_BASE}/webhook/oauth/patreon/poll`,
  authValidate: `${N8N_BASE}/webhook/oauth/patreon/validate`,
  feedback:     `${N8N_BASE}/webhook/feedback`,
  image:        `${N8N_BASE}/webhook/npc-image`,
  heartbeat:    `${N8N_BASE}/webhook/heartbeat`,
};

export const PATREON_URL = 'https://www.patreon.com/cw/CelestiaTools';

/** Returns the URL with a '-dev' suffix appended when dev-mode is active. */
export function devUrl(base, devMode) {
  return devMode ? base + '-dev' : base;
}

/** Resolve dev-mode from Foundry settings (returns false when unavailable). */
export function isDevMode(moduleId) {
  try { return game.settings?.get(moduleId, 'devMode') ?? false; } catch (_) { return false; }
}
