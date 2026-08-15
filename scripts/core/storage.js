/**
 * localStorage helpers, namespaced per module folder.
 * Keys are pure data — no JSON nesting per slot.
 * All methods silently swallow storage errors (e.g. private browsing quota limits).
 */

export class Storage {
  /**
   * @param {string} moduleFolder  The module's folder name, used to namespace all storage keys.
   */
  constructor(moduleFolder) {
    this.folder      = moduleFolder;
    this.keyPrimary  = `${moduleFolder}.key`;
    this.keyLegacy   = `${moduleFolder}:key`;
    this.historyKey  = `${moduleFolder}.history`;
    this.versionKey  = `${moduleFolder}.module-version`;
    this.artStyleKey = `${moduleFolder}.art-style`;
  }

  /* ── Patreon session key ────────────────────────────────── */

  /** @returns {string} The stored session key, or an empty string if absent. */
  getKey() {
    for (const k of [this.keyPrimary, this.keyLegacy]) {
      try { const v = localStorage.getItem(k); if (v) return v; } catch (_) {}
    }
    return '';
  }

  /**
   * Persist a session key. Pass an empty string (or falsy) to clear it.
   * @param {string} value
   */
  setKey(value) {
    try {
      if (value) {
        localStorage.setItem(this.keyPrimary, value);
        localStorage.setItem(this.keyLegacy, value);
      } else {
        localStorage.removeItem(this.keyPrimary);
        localStorage.removeItem(this.keyLegacy);
      }
    } catch (_) {}
  }

  /* ── History ────────────────────────────────────────────── */

  /**
   * @param {number} [maxEntries=50]  Maximum number of entries to return.
   * @returns {import('./adapter.js').HistoryEntry[]}
   */
  loadHistory(maxEntries = 50) {
    try {
      const raw = localStorage.getItem(this.historyKey);
      if (raw) return JSON.parse(raw).slice(-maxEntries);
    } catch (_) {}
    return [];
  }

  /**
   * @param {import('./adapter.js').HistoryEntry[]} history
   * @param {number} [maxEntries=50]
   */
  saveHistory(history, maxEntries = 50) {
    try {
      localStorage.setItem(this.historyKey, JSON.stringify(history.slice(-maxEntries)));
    } catch (_) {}
  }

  /* ── Module version (used to invalidate sessions on update) ── */

  /** @returns {string} The last-seen module version, or empty string if unset. */
  getVersion() {
    try { return localStorage.getItem(this.versionKey) || ''; } catch (_) { return ''; }
  }

  /** @param {string} version */
  setVersion(version) {
    try { localStorage.setItem(this.versionKey, version); } catch (_) {}
  }

  /* ── Custom art style ───────────────────────────────────── */

  /** @returns {string} The user's custom art-style prompt, or empty string if unset. */
  getArtStyle() {
    try { return localStorage.getItem(this.artStyleKey) || ''; } catch (_) { return ''; }
  }

  /** @param {string} style */
  setArtStyle(style) {
    try { localStorage.setItem(this.artStyleKey, style); } catch (_) {}
  }

  /* ── Clear all module storage ───────────────────────────── */

  /** Removes every key stored under this module's namespace. */
  clear() {
    const keys = [
      this.keyPrimary,
      this.keyLegacy,
      this.historyKey,
      this.versionKey,
      this.artStyleKey,
    ];
    for (const k of keys) {
      try { localStorage.removeItem(k); } catch (_) {}
    }
  }
}
