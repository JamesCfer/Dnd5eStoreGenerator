/**
 * Heartbeat — pings the relay once on startup and once per hour so the server
 * knows this client is live. Reports the sending module, the Foundry/system
 * versions, and the full list of installed modules (ours and otherwise).
 */

import { N8N_ENDPOINTS, devUrl, isDevMode } from './n8n.js';

const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000;
const startedModules = new Set();

function collectInstalledModules() {
  const out = [];
  try {
    for (const mod of game.modules?.values?.() ?? []) {
      out.push({ id: mod.id, version: mod.version || '', active: !!mod.active });
    }
  } catch (_) {}
  return out;
}

function buildPayload(moduleId) {
  const mod = game.modules?.get?.(moduleId);
  return {
    moduleId,
    moduleVersion:    mod?.version || '',
    foundryVersion:   game.version || game.data?.version || '',
    systemId:         game.system?.id || '',
    systemVersion:    game.system?.version || '',
    installedModules: collectInstalledModules(),
    sentAt:           new Date().toISOString(),
  };
}

async function sendHeartbeat(moduleId) {
  try {
    const url = devUrl(N8N_ENDPOINTS.heartbeat, isDevMode(moduleId));
    await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(buildPayload(moduleId)),
      keepalive: true,
    });
  } catch (_) {
    /* Network errors are expected when offline — swallow silently. */
  }
}

/**
 * Begin sending heartbeats for the given module. Safe to call once per
 * module's `ready` hook; subsequent calls for the same module are no-ops.
 */
export function startHeartbeat(moduleId) {
  if (!moduleId || startedModules.has(moduleId)) return;
  startedModules.add(moduleId);
  sendHeartbeat(moduleId);
  setInterval(() => sendHeartbeat(moduleId), HEARTBEAT_INTERVAL_MS);
}
