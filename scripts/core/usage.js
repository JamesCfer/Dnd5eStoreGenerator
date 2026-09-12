/**
 * Shared usage tracker — remembers how many monthly generation uses the
 * signed-in Patreon member has left, so every builder can display it.
 *
 * The relay reports usage two ways and we accept both:
 *   - Response headers: X-Uses-Remaining / X-Uses-Limit / X-Uses-Used
 *   - JSON body fields: usesRemaining | remaining | usesLeft (and limit / used),
 *     optionally nested under a `usage` object.
 *
 * The usage-check endpoint also reports the member's Patreon `tier` and the
 * `resetDate` of the current allowance window; both are tracked here so the
 * builder can explain the allowance instead of just counting it down.
 *
 * Every n8n call that carries auth (generation, image, validate) funnels its
 * response through updateUsageFromResponse(), so the count stays fresh without
 * a dedicated endpoint. Listeners (the BuilderApp uses pill) are notified on
 * every change.
 */

/**
 * @typedef {object} UsageInfo
 * @property {number|null} remaining
 * @property {number|null} limit
 * @property {string|null} tier       Relay-reported Patreon tier id.
 * @property {number|null} resetAt    Epoch ms when the allowance resets.
 * @property {number}      updatedAt
 */

/** @type {UsageInfo} */
const _usage = { remaining: null, limit: null, tier: null, resetAt: null, updatedAt: 0 };

/** @type {Set<(usage: UsageInfo) => void>} */
const _listeners = new Set();

function _toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Parse an ISO date string (or epoch ms) into epoch ms.
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
function _toTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

function _notify() {
  for (const cb of _listeners) {
    try { cb({ ..._usage }); } catch (_) {}
  }
}

/** @returns {UsageInfo} A copy of the last-known usage numbers. */
export function getUsage() {
  return { ..._usage };
}

/**
 * Record new usage numbers. Pass null to leave a field unchanged;
 * only fires listeners when something actually changed.
 *
 * @param {number|null} remaining
 * @param {number|null} [limit]
 * @param {string|null} [tier]
 * @param {number|null} [resetAt]  Epoch ms.
 */
export function setUsage(remaining, limit = null, tier = null, resetAt = null) {
  const r = _toNumber(remaining);
  const l = _toNumber(limit);
  const t = typeof tier === 'string' && tier.trim() ? tier.trim().toLowerCase() : null;
  const reset = _toNumber(resetAt);
  let changed = false;
  if (r !== null && r !== _usage.remaining) { _usage.remaining = r; changed = true; }
  if (l !== null && l !== _usage.limit)     { _usage.limit = l;     changed = true; }
  if (t !== null && t !== _usage.tier)      { _usage.tier = t;      changed = true; }
  if (reset !== null && reset !== _usage.resetAt) { _usage.resetAt = reset; changed = true; }
  if (changed) {
    _usage.updatedAt = Date.now();
    _notify();
  }
}

/** Forget the stored numbers (e.g. on sign-out). Fires listeners. */
export function clearUsage() {
  _usage.remaining = null;
  _usage.limit     = null;
  _usage.tier      = null;
  _usage.resetAt   = null;
  _usage.updatedAt = Date.now();
  _notify();
}

/**
 * Subscribe to usage changes. Returns an unsubscribe function.
 * @param {(usage: UsageInfo) => void} callback
 * @returns {() => void}
 */
export function onUsageChange(callback) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

/**
 * Pull usage numbers out of a parsed JSON body, tolerating the field-name
 * variants the relay has used over time.
 *
 * @param {object|null|undefined} data
 * @returns {{ remaining: number|null, limit: number|null, tier: string|null, resetAt: number|null }}
 */
export function extractUsageFromData(data) {
  if (!data || typeof data !== 'object') return { remaining: null, limit: null, tier: null, resetAt: null };
  const scopes = [data, data.usage].filter(s => s && typeof s === 'object');
  let remaining = null, limit = null, used = null, tier = null, resetAt = null;
  for (const s of scopes) {
    if (remaining === null) remaining = _toNumber(s.usesRemaining ?? s.remaining ?? s.usesLeft);
    if (limit     === null) limit     = _toNumber(s.limit ?? s.usesLimit ?? s.max);
    if (used      === null) used      = _toNumber(s.used ?? s.usesUsed);
    if (tier      === null && typeof s.tier === 'string' && s.tier.trim()) tier = s.tier.trim().toLowerCase();
    if (resetAt   === null) resetAt   = _toTimestamp(s.resetDate ?? s.resetAt ?? s.resetsAt);
  }
  if (remaining === null && limit !== null && used !== null) {
    remaining = Math.max(0, limit - used);
  }
  return { remaining, limit, tier, resetAt };
}

/**
 * Update the tracker from an n8n response — checks headers first, then the
 * (already-parsed) JSON body. Safe to call with either argument missing.
 *
 * @param {Response|null}          [response]  The fetch Response (for headers).
 * @param {object|null|undefined}  [data]      The parsed JSON body, if any.
 */
export function updateUsageFromResponse(response, data) {
  let remaining = null, limit = null, tier = null, resetAt = null;
  try {
    if (response?.headers?.get) {
      remaining = _toNumber(response.headers.get('X-Uses-Remaining'));
      limit     = _toNumber(response.headers.get('X-Uses-Limit'));
      if (remaining === null) {
        const used = _toNumber(response.headers.get('X-Uses-Used'));
        if (limit !== null && used !== null) remaining = Math.max(0, limit - used);
      }
    }
  } catch (_) {}
  const fromBody = extractUsageFromData(data);
  if (remaining === null) remaining = fromBody.remaining;
  if (limit     === null) limit     = fromBody.limit;
  tier    = fromBody.tier;
  resetAt = fromBody.resetAt;
  // A 429 means the allowance is definitively spent even if the body omits it.
  if (remaining === null && response?.status === 429) remaining = 0;
  setUsage(remaining, limit, tier, resetAt);
}
