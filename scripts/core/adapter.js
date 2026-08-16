/**
 * SystemAdapter — the contract between the shared BuilderApp and a per-module
 * system implementation.
 *
 * A subclass MUST set:
 *   - moduleFolder         (string)  — folder name under /modules/, used for storage keys
 *   - module               (ModuleInfo) — { id, label, icon, githubUrl, historyLabel }
 *   - systemId             (string)  — Foundry game system id ('pf2e', 'dnd5e', 'hero6e')
 *   - formConfig           (FormConfig) — labels/placeholders for the shared shell template
 *
 * A subclass MUST implement:
 *   - gatherFormData(form)            → { name, level, description, ...module-specific }
 *   - historyEntryFromForm(formData)  → fields to merge into the history entry
 *   - historyMeta(entry)              → string (HTML-safe; e.g. 'Lv.&nbsp;1')
 *   - populateForm(form, entry)       → void  (recreate form values from history entry)
 *   - generate({formData,key,...})    → AdapterResult
 *
 * Optional:
 *   - supportsImageGeneration         (boolean, default false)
 *   - registerSheetHooks(getApp)      → registers Hooks for sheet button injection
 */

/* ── Shared type definitions ─────────────────────────────── */

/**
 * @typedef {object} ModuleInfo
 * @property {string} id            Foundry module id.
 * @property {string} label         Short display name.
 * @property {string} icon          FontAwesome class string.
 * @property {string} githubUrl     Repository URL.
 * @property {string} historyLabel  Panel heading for the history list.
 */

/**
 * @typedef {object} FormConfig
 * @property {string} documentNoun  Human-readable noun for the document type ('NPC', 'item', …).
 */

/**
 * @typedef {object} ExportData
 * @property {string} content   Serialised document (JSON, XML, …).
 * @property {string} filename  Suggested download filename including extension.
 * @property {string} mimeType  MIME type for the Blob.
 */

/**
 * @typedef {object} AdapterResult
 * @property {object}      document    Foundry Actor or Item instance.
 * @property {ExportData}  [exportData]
 * @property {string}      [message]   Success notification text.
 */

/**
 * @typedef {object} GenerateOptions
 * @property {object}  formData    Gathered form values (shape varies per adapter).
 * @property {string}  key         Patreon session key.
 * @property {boolean} devMode     Whether to hit the '-dev' n8n endpoints.
 * @property {object}  [builderApp] The calling BuilderApp instance.
 */

/**
 * @typedef {'generating'|'success'|'error'} EntryStatus
 */

/**
 * @typedef {object} HistoryEntry
 * @property {string}      id        Random 16-char Foundry ID.
 * @property {string}      name      Document name as entered in the form.
 * @property {EntryStatus} status
 * @property {number}      createdAt Unix timestamp (Date.now()).
 * @property {string|null} error     Error message when status is 'error'.
 */

/**
 * @typedef {object} N8nPostResult
 * @property {Response} response
 * @property {string}   responseText
 */

/* ── Custom error classes ────────────────────────────────── */

/** Thrown when Patreon authentication fails (HTTP 401/403). */
export class AuthError extends Error {
  /** @param {string} [message] */
  constructor(message) {
    super(message || 'Authentication failed.');
    this.name = 'AuthError';
  }
}

/** Thrown when the user's monthly generation limit is reached (HTTP 429). */
export class RateLimitError extends Error {
  /**
   * @param {string} [message]
   * @param {string} [tier]     Patreon tier label used for the upgrade prompt.
   * @param {number} [resetAt]  Unix timestamp (ms) when the limit resets, or null.
   */
  constructor(message, tier, resetAt) {
    super(message || 'Monthly limit reached.');
    this.name = 'RateLimitError';
    /** @type {string|undefined} */
    this.tier = tier;
    /** @type {number|null} */
    this.resetAt = resetAt || null;
  }
}

/**
 * Thrown when Foundry document creation fails after all auto-fix retries.
 * Carries the raw server-returned data so the user can download it.
 */
export class ActorCreationError extends Error {
  /**
   * @param {string} [message]
   * @param {object} [rawData]  The raw actor/item data from the server.
   */
  constructor(message, rawData) {
    super(message || 'Document creation failed.');
    this.name = 'ActorCreationError';
    /** @type {object|null} */
    this.rawData = rawData || null;
  }
}

/* ── SystemAdapter abstract base ─────────────────────────── */

export class SystemAdapter {
  constructor() {
    if (new.target === SystemAdapter) {
      throw new Error('SystemAdapter is abstract — subclass it per module.');
    }
  }

  /**
   * Checks all required getters on a concrete adapter instance and throws a
   * descriptive error for the first one that returns empty or throws.
   * @param {SystemAdapter} adapter
   */
  static validate(adapter) {
    const checks = [
      ['moduleFolder',            () => adapter.moduleFolder],
      ['module.id',               () => adapter.module?.id],
      ['module.label',            () => adapter.module?.label],
      ['systemId',                () => adapter.systemId],
      ['formConfig.documentNoun', () => adapter.formConfig?.documentNoun],
    ];
    for (const [name, get] of checks) {
      let value;
      try { value = get(); } catch (err) {
        throw new Error(`${adapter.constructor.name}: getter "${name}" threw — ${err.message}`);
      }
      if (!value) {
        throw new Error(`${adapter.constructor.name}: "${name}" must return a non-empty value`);
      }
    }
  }

  /** @returns {string} */
  get moduleFolder() { throw new Error(`${this.constructor.name} must implement get moduleFolder()`); }

  /** @returns {ModuleInfo} */
  get module() { throw new Error(`${this.constructor.name} must implement get module()`); }

  /** @returns {string} Foundry game system id. */
  get systemId() { throw new Error(`${this.constructor.name} must implement get systemId()`); }

  /** @returns {FormConfig} */
  get formConfig() { throw new Error(`${this.constructor.name} must implement get formConfig()`); }

  /** @returns {boolean} */
  get supportsImageGeneration() { return false; }

  /**
   * Returns an array of fields to show in the post-generation quick-edit dialog,
   * or null to skip the dialog and open the sheet directly.
   *
   * Each field: { key: string, label: string, value: any, type: 'text'|'number',
   *               min?: number, max?: number, step?: number }
   *
   * `key` is a Foundry dot-path accepted by document.update().
   *
   * @param {object} _document  The freshly created Foundry document.
   * @returns {Array<object>|null}
   */
  quickEditFields(_document) { return null; }

  /** @returns {string[]} Ordered step labels shown during generation. */
  get progressSteps() { return ['Sending request…', 'Creating document…']; }

  /* ── Methods to override ────────────────────────────────── */

  /**
   * @param {HTMLFormElement} _form
   * @returns {object} Gathered form values (shape is adapter-specific).
   */
  gatherFormData(_form) {
    throw new Error(`${this.constructor.name} must implement gatherFormData(form)`);
  }

  /**
   * @param {object} _formData
   * @returns {Partial<HistoryEntry>} Fields to merge into the new history entry.
   */
  historyEntryFromForm(_formData) {
    throw new Error(`${this.constructor.name} must implement historyEntryFromForm(formData)`);
  }

  /**
   * @param {HistoryEntry} _entry
   * @returns {string} HTML-safe metadata string (e.g. 'Lv.&nbsp;1').
   */
  historyMeta(_entry) {
    return '';
  }

  /**
   * @param {HTMLFormElement} _form
   * @param {HistoryEntry}    _entry
   * @returns {void}
   */
  populateForm(_form, _entry) {
    /* no-op default */
  }

  /**
   * @param {GenerateOptions} _opts
   * @returns {Promise<AdapterResult>}
   */
  async generate(_opts) {
    throw new Error(`${this.constructor.name} must implement generate(opts)`);
  }

  /**
   * @param {() => object} _getApp  Returns the running BuilderApp instance.
   * @returns {void}
   */
  registerSheetHooks(_getApp) {
    /* no-op default */
  }

  /**
   * Called once after the builder form is mounted in the DOM, giving the
   * adapter a chance to wire up form-specific event listeners (e.g. a live
   * cost-estimate hint).
   *
   * @param {HTMLElement} _form  The `.npc-form` element.
   * @returns {void}
   */
  onFormMount(_form) {
    /* no-op default */
  }
}

/* ── Shared network helper ───────────────────────────────── */

import { updateUsageFromResponse } from './usage.js';

/**
 * POSTs to an n8n webhook with Patreon auth headers.
 * Maps 401/403 → AuthError and 429 → RateLimitError.
 * Feeds usage numbers (uses remaining) from the response into the shared
 * usage tracker so builders can display them.
 *
 * @param {string} endpoint
 * @param {object} payload
 * @param {string} key
 * @returns {Promise<N8nPostResult>}
 */
/**
 * Ask the relay for the member's current used/limit numbers. postToN8n
 * funnels the response through updateUsageFromResponse, so callers only
 * need to fire this — the usage tracker and every open builder update
 * themselves. Silent on failure (no key, offline, expired session).
 */
export async function refreshUsageFromServer(moduleId) {
  try {
    const { Storage } = await import('./storage.js');
    const { N8N_ENDPOINTS, devUrl, isDevMode } = await import('./n8n.js');
    const key = new Storage(moduleId).getKey();
    if (!key) return;
    await postToN8n(devUrl(N8N_ENDPOINTS.usageCheck, isDevMode(moduleId)), {}, key);
  } catch (_) { /* usage refresh is best-effort */ }
}

export async function postToN8n(endpoint, payload, key) {
  const response = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Builder-Key':    key,
      'X-Foundry-Origin': window.location.origin,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();

  let parsedBody = null;
  try { parsedBody = JSON.parse(responseText); } catch (_) {}
  updateUsageFromResponse(response, parsedBody);

  if (response.status === 401 || response.status === 403) {
    let data; try { data = JSON.parse(responseText); } catch { data = {}; }
    throw new AuthError(data?.message || 'Unauthorized. Please sign in with Patreon.');
  }

  if (response.status === 429) {
    let data; try { data = JSON.parse(responseText); } catch { data = {}; }
    const limit = data?.limit || 0;
    const tierMap = { 3: 'Free', 15: 'Local Adventurer', 50: 'Standard', 80: 'Champion' };
    const tier = limit && tierMap[limit] ? tierMap[limit] : null;

    let resetAt = null;
    if (data?.reset)        resetAt = Number(data.reset) * 1000;
    else if (data?.resetAt) resetAt = new Date(data.resetAt).getTime();
    if (!resetAt || isNaN(resetAt)) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const secs = parseInt(retryAfter, 10);
        if (!isNaN(secs)) resetAt = Date.now() + secs * 1000;
      }
    }

    throw new RateLimitError(data?.message || 'Monthly limit reached.', tier, resetAt);
  }

  return { response, responseText };
}
