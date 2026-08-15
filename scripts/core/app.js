/**
 * BuilderApp — the shared ApplicationV2 shell used by every builder module.
 *
 * Responsibilities:
 *   - Patreon authentication (sign-in, sign-out, key storage)
 *   - History panel (in-memory + localStorage persistence)
 *   - Feedback panel
 *   - Image generation (delegated to image-gen.js)
 *   - Form rendering (the system-specific fields are inlined in the template)
 *   - Generation flow: hands form data to the SystemAdapter and wires the result
 *     back into Foundry
 *
 * What this file does NOT know:
 *   - How to build a payload for a specific n8n endpoint
 *   - How to sanitize a system-specific actor/item document
 *   - How to inject sheet buttons for a specific system
 *
 * Those live in each module's adapter (modules/<Name>/scripts/adapter.js).
 */

import { Storage }                from './storage.js';
import { AuthError,
         RateLimitError,
         ActorCreationError,
         SystemAdapter }          from './adapter.js';
import { startPatreonSignIn,
         validateSessionKey,
         PATREON_URL }            from './auth.js';
import { sendFeedback }           from './feedback.js';
import { initConsoleCapture,
         getConsoleLog }          from './console-capture.js';
import { generateImage,
         IMAGE_COST }             from './image-gen.js';
import { isDevMode }              from './n8n.js';
import { getUsage,
         clearUsage,
         onUsageChange }          from './usage.js';
import { ALL_MODULES,
         getModuleMeta }          from './home-data.js';
import { escapeHtml,
         detectModuleFolder,
         generateThematicName }   from './utils.js';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export const MAX_HISTORY = 50;

export class BuilderApp extends HandlebarsApplicationMixin(ApplicationV2) {
  /**
   * @param {SystemAdapter} adapter  The per-module system adapter.
   * @param {object}        options  ApplicationV2 options (merged with adapter defaults).
   */
  constructor(adapter, options = {}) {
    const { initialTab, ...appOptions } = options;
    super(appOptions);
    SystemAdapter.validate(adapter);
    this.adapter        = adapter;
    this.moduleFolder   = adapter.moduleFolder;
    this.storage        = new Storage(this.moduleFolder);
    this.accessKey      = this.storage.getKey() || '';
    this.authenticated  = !!this.accessKey;
    this.lastDocument   = null;
    this.lastExportData = null;     // adapter-defined: { content, filename, mimeType }
    this._isOffline     = !navigator.onLine;
    // Default to the builder form — users reach the Home tab by clicking it.
    this.activeTab      = (initialTab === 'home' || initialTab === 'builder') ? initialTab : 'builder';
    this.selectedHistoryId = null;
    this.patreonTier    = null;

    this._stepTimers = new Map();
    this._historyFilter = '';
    this._historyCompact = false;

    this.history = this.storage.loadHistory(MAX_HISTORY);
    let hadStale = false;
    for (const entry of this.history) {
      if (entry.status === 'generating') {
        entry.status = 'error';
        entry.error  = 'Session was interrupted';
        hadStale = true;
      }
    }
    if (hadStale) this.storage.saveHistory(this.history, MAX_HISTORY);
  }

  /* ── ApplicationV2 wiring ──────────────────────────────── */

  async _prepareContext() {
    const currentId     = this.adapter.module.id;
    const currentSystem = ALL_MODULES.find(m => m.id === currentId)?.system;
    return {
      authenticated: this.authenticated,
      module:        this.adapter.module,
      documentNoun:  this.adapter.formConfig?.documentNoun || 'document',
      patreonUrl:    PATREON_URL,
      homeModules:   ALL_MODULES
        .filter(m => {
          if (m.id === currentId) return true;
          // Only advertise siblings that target the same Foundry system…
          if (m.system !== currentSystem) return false;
          // …and only if the user doesn't already have them installed.
          return !game.modules?.get(m.id);
        })
        .map(m => ({ ...m, isCurrent: m.id === currentId })),
    };
  }

  _onRender(context, options) {
    initConsoleCapture();

    // Bind tab clicks (Home + Builder) — bypasses ApplicationV2 action delegation
    // which can be intercepted by system-level CSS/JS overrides.
    this.element.querySelectorAll('.builder-tab[data-tab]').forEach(btn => {
      btn.addEventListener('click', ev => {
        ev.preventDefault();
        ev.stopPropagation();
        const tab = btn.dataset.tab;
        if (tab === 'home' || tab === 'builder') {
          this.activeTab = tab;
          this._applyTabUI();
        }
      });
    });

    this._applyTabUI();
    this._renderHistory();

    const filterInput = this.element.querySelector('.history-search-input');
    if (filterInput) {
      filterInput.value = this._historyFilter;
      filterInput.addEventListener('input', () => {
        this._historyFilter = filterInput.value.trim().toLowerCase();
        this._renderHistory();
      });
    }

    const artStyleInput = this.element.querySelector('#npc-art-style');
    if (artStyleInput) {
      artStyleInput.value = this.storage.getArtStyle();
      artStyleInput.addEventListener('input', () => {
        this.storage.setArtStyle(artStyleInput.value.trim());
      });
    }

    const compactBtn = this.element.querySelector('.history-compact-btn');
    if (compactBtn) {
      compactBtn.addEventListener('click', () => this._toggleCompactHistory());
      if (this._historyCompact) {
        this.element.querySelector('.npc-panel-history')?.classList.add('is-compact');
        compactBtn.setAttribute('aria-pressed', 'true');
      }
    }

    const tmplSelect = this.element.querySelector('.desc-template-select');
    if (tmplSelect) {
      tmplSelect.addEventListener('change', () => {
        if (!tmplSelect.value) return;
        const desc = this.element.querySelector('[name="description"]');
        if (desc) desc.value = tmplSelect.value;
        tmplSelect.selectedIndex = 0;
      });
    }

    const nameField = this.element.querySelector('.field--name');
    const nameLabel = nameField?.querySelector('label');
    if (nameLabel && !nameField.querySelector('.suggest-name-btn, .btn-roll-name')) {
      const suggestBtn = document.createElement('button');
      suggestBtn.type = 'button';
      suggestBtn.className = 'suggest-name-btn';
      suggestBtn.title = 'Suggest a thematic name based on the description';
      suggestBtn.setAttribute('aria-label', 'Suggest a name');
      suggestBtn.innerHTML = '<i class="fa-solid fa-dice-d20"></i> Suggest';
      suggestBtn.addEventListener('click', () => this._suggestName());
      nameLabel.appendChild(suggestBtn);
    }

    this._initOfflineDetection();

    // Keep the "uses left" pill in the auth banner up to date.
    this._unsubscribeUsage?.();
    this._unsubscribeUsage = onUsageChange(() => this._updateUsesDisplay());
    this._updateUsesDisplay();

    this._validateSessionOnOpen();

    const mountForm = this.element.querySelector('.npc-form');
    if (mountForm && typeof this.adapter.onFormMount === 'function') {
      this.adapter.onFormMount(mountForm);
    }

    this.element.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        if (this.activeTab === 'builder') this._generate(ev);
      } else if (ev.key === 'Escape') {
        const form = this.element.querySelector('.npc-form');
        if (form?.contains(document.activeElement)) {
          ev.preventDefault();
          ev.stopPropagation();
          form.querySelectorAll('input[type="text"], input[type="number"], textarea').forEach(el => { el.value = ''; });
          form.querySelectorAll('input[type="checkbox"]').forEach(el => { el.checked = false; });
          form.querySelectorAll('select').forEach(el => { el.selectedIndex = 0; });
        }
      }
    }, true);
  }

  /* ── Tab UI (Home vs Builder) ──────────────────────────── */

  _applyTabUI() {
    const root = this.element;
    if (!root) return;

    root.querySelectorAll('.builder-tab').forEach(btn => {
      const isActive = btn.dataset.tab === this.activeTab;
      btn.classList.toggle('is-active', isActive);
      btn.setAttribute('aria-selected', String(isActive));
    });

    const homePanel    = root.querySelector('.home-panel');
    const builderInner = root.querySelector('.builder-inner');
    const isHome = this.activeTab === 'home';
    if (homePanel)    homePanel.style.display    = isHome ? 'flex' : 'none';
    if (builderInner) builderInner.style.display = isHome ? 'none' : 'flex';

    this._applyAuthStateUI();
  }

  /* ── Auth state UI ──────────────────────────────────────── */

  _applyAuthStateUI() {
    const root = this.element;
    if (!root) return;

    root.classList.toggle('is-authenticated', !!this.authenticated);

    const anyGenerating = this.history.some(e => e.status === 'generating');
    root.classList.toggle('is-generating', anyGenerating);

    for (const action of ['generate', 'export', 'generateimage']) {
      const btn = root.querySelector(`button[data-action="${action}"]`);
      if (btn) {
        btn.disabled = !this.authenticated
          || (action === 'generate' && this._isOffline)
          || (action === 'generate' && anyGenerating);
        btn.setAttribute('aria-busy', String(action === 'generate' && anyGenerating));
      }
    }

    this._updateUsesDisplay();

    const undoBtn = root.querySelector('button[data-action="undolast"]');
    if (undoBtn) undoBtn.disabled = !this.lastDocument;
  }

  /* ── Uses-remaining display ─────────────────────────────── */

  _updateUsesDisplay() {
    const pill = this.element?.querySelector('.auth-uses-pill');
    if (!pill) return;
    const { remaining, limit } = getUsage();
    if (!this.authenticated || remaining === null) {
      pill.style.display = 'none';
      return;
    }
    const countEl = pill.querySelector('.auth-uses-count');
    if (countEl) {
      countEl.textContent = limit !== null
        ? `${remaining} / ${limit} uses left`
        : `${remaining} uses left`;
    }
    pill.classList.toggle('auth-uses-pill--low', remaining <= 5);
    pill.style.display = '';
  }

  /* ── Action wiring ──────────────────────────────────────── */

  /* ── ApplicationV2 static config ───────────────────────── */

  /**
   * Base DEFAULT_OPTIONS shared by every module. The per-module factory
   * in `openBuilder` merges in `id`, `window.title`, and `classes` that
   * depend on the running module.
   *
   * We also set DEFAULT_OPTIONS directly so a BuilderApp can render
   * without subclassing (the factory still overrides it with per-module
   * fields).
   */
  static DEFAULT_OPTIONS = {
    id:       'npc-builder-app',
    classes:  ['npc-builder'],
    tag:      'div',
    window:   { title: 'NPC Builder', resizable: true },
    position: { width: 800 },
    actions: {
      signin:        function(event) { this._signIn(event); },
      signout:       function(event) { this._signOut(event); },
      generate:      function(event) { this._generate(event); },
      export:        function(event) { this._export(event); },
      patreon:       function()      { window.open(PATREON_URL, '_blank'); },
      sendfeedback:  function(event) { this._sendFeedback(event); },
      generateimage: function(event) { this._generateImage(event); },
      clearhistory:  function(event) { this._clearHistory(event); },
      undolast:      function(event) { this._undoLastGeneration(event); },
    },
  };

  /**
   * PARTS is overridden by the per-module factory subclass in openBuilder.
   * Leaving it empty here means an un-subclassed BuilderApp will render
   * nothing, which is the desired behaviour (you should always use the factory).
   */
  static PARTS = {};

  /* ── Auth actions ───────────────────────────────────────── */

  async _signIn(event) {
    event?.preventDefault?.();
    ui.notifications?.info?.(game.i18n.localize('NpcBuilder.SignIn.Opening'));
    try {
      const key = await startPatreonSignIn({ devMode: isDevMode(this.moduleFolder) });
      this.accessKey = key;
      this.storage.setKey(key);
      this.authenticated = true;
      this._applyAuthStateUI();
      ui.notifications?.info?.(game.i18n.localize('NpcBuilder.SignIn.Complete'));
    } catch (err) {
      console.error('[NPC Builder] sign-in failed:', err);
      ui.notifications?.error?.(err.message || game.i18n.localize('NpcBuilder.SignIn.Failed'), { permanent: true });
      setTimeout(() => window.open(PATREON_URL, '_blank'), 800);
    }
  }

  async _signOut(event) {
    event?.preventDefault?.();
    this.storage.setKey('');
    this.accessKey = '';
    this.authenticated = false;
    clearUsage();
    this._applyAuthStateUI();
    ui.notifications?.info?.(game.i18n.localize('NpcBuilder.SignOut.Success'));
  }

  /* ── History rendering ──────────────────────────────────── */

  _renderHistory() {
    const list = this.element?.querySelector('.history-list');
    if (!list) return;
    list.innerHTML = '';

    const query    = this._historyFilter || '';
    const reversed = [...this.history].reverse();
    const filtered = query
      ? reversed.filter(e => e.name?.toLowerCase().includes(query))
      : reversed;

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'history-empty';
      empty.textContent = query
        ? `No ${this.adapter.formConfig.documentNoun || 'documents'} match "${query}".`
        : `No ${this.adapter.formConfig.documentNoun || 'documents'} created yet.\nGenerate one to see it here.`;
      list.appendChild(empty);
      return;
    }

    for (const entry of filtered) {
      list.appendChild(this._createHistoryEntryElement(entry));
    }
  }

  _createHistoryEntryElement(entry) {
    const el = document.createElement('div');
    el.className = `history-entry history-entry--${entry.status}`;
    el.dataset.entryId = entry.id;
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.setAttribute('aria-label', `${entry.name} — ${entry.status}`);
    if (entry.status === 'generating') el.setAttribute('aria-busy', 'true');
    if (this.selectedHistoryId === entry.id) {
      el.classList.add('is-selected');
      el.setAttribute('aria-current', 'true');
    }

    const statusIcon = {
      generating: '<i class="fa-solid fa-circle-notch fa-spin"></i>',
      success:    '<i class="fa-solid fa-circle-check"></i>',
      error:      '<i class="fa-solid fa-circle-xmark"></i>',
    }[entry.status] ?? '<i class="fa-solid fa-circle"></i>';

    const escapedName  = escapeHtml(entry.name);
    const escapedError = entry.error ? escapeHtml(entry.error) : '';
    const metaLabel    = this.adapter.historyMeta(entry);

    el.innerHTML = `
      <div class="history-entry-main">
        <div class="history-entry-info">
          <span class="history-entry-name">${escapedName}</span>
          <span class="history-entry-meta">${metaLabel}</span>
        </div>
        <div class="history-entry-actions">
          <div class="history-entry-icon">${statusIcon}</div>
          ${entry.status !== 'generating'
            ? `<button type="button" class="history-entry-duplicate" title="Pre-fill form with this entry" aria-label="Duplicate ${escapedName}"><i class="fa-solid fa-copy"></i></button>
               <button type="button" class="history-entry-delete" title="Delete this entry" aria-label="Delete ${escapedName}"><i class="fa-solid fa-xmark"></i></button>`
            : ''}
        </div>
      </div>
      ${entry.status === 'generating'
        ? `<span class="history-step-label">${escapeHtml(this.adapter.progressSteps[0])}</span>
      <div class="history-progress"><div class="history-progress-bar"></div></div>`
        : ''}
      ${entry.status === 'error'
        ? `<div class="history-entry-footer">
            ${escapedError ? `<div class="history-entry-error">${escapedError}</div>` : ''}
            <button type="button" class="history-entry-retry"><i class="fa-solid fa-rotate-right"></i> Retry</button>
          </div>`
        : ''}
    `;

    const retryBtn = el.querySelector('.history-entry-retry');
    if (retryBtn) {
      retryBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._resubmit(entry);
      });
    }

    const dupBtn = el.querySelector('.history-entry-duplicate');
    if (dupBtn) {
      dupBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._duplicateFromHistory(entry);
      });
    }

    const deleteBtn = el.querySelector('.history-entry-delete');
    if (deleteBtn) {
      deleteBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this._deleteHistoryEntry(entry.id);
      });
    }

    el.addEventListener('click', () => this._selectHistoryEntry(entry));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        this._selectHistoryEntry(entry);
      }
    });
    return el;
  }

  _selectHistoryEntry(entry) {
    this.selectedHistoryId = entry.id;

    const form = this.element?.querySelector('.npc-form');
    if (form) this.adapter.populateForm(form, entry);

    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) {
      banner.style.display = 'flex';
      const strong = banner.querySelector('strong');
      if (strong) strong.textContent = entry.name;
    }

    this.element?.querySelectorAll('.history-entry').forEach(el => {
      el.classList.toggle('is-selected', el.dataset.entryId === entry.id);
    });
  }

  _updateHistoryEntry(id, changes) {
    const entry = this.history.find(e => e.id === id);
    if (!entry) return;

    if (changes.status && changes.status !== 'generating') {
      this._clearStepTimer(id);
    }

    Object.assign(entry, changes);
    this.storage.saveHistory(this.history, MAX_HISTORY);

    const el = this.element?.querySelector(`.history-entry[data-entry-id="${id}"]`);
    if (el) {
      const newEl = this._createHistoryEntryElement(entry);
      el.parentNode.replaceChild(newEl, el);
    }

    const anyGenerating = this.history.some(e => e.status === 'generating');
    this.element?.classList.toggle('is-generating', anyGenerating);
  }

  _deleteHistoryEntry(id) {
    const idx = this.history.findIndex(e => e.id === id);
    if (idx === -1) return;
    this.history.splice(idx, 1);
    this.storage.saveHistory(this.history, MAX_HISTORY);
    if (this.selectedHistoryId === id) {
      this.selectedHistoryId = null;
      const banner = this.element?.querySelector('.history-selected-banner');
      if (banner) banner.style.display = 'none';
    }
    this._renderHistory();
  }

  _duplicateFromHistory(entry) {
    const form = this.element?.querySelector('.npc-form');
    if (form) this.adapter.populateForm(form, entry);
    this.selectedHistoryId = null;
    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) banner.style.display = 'none';
    this.element?.querySelectorAll('.history-entry.is-selected').forEach(el => el.classList.remove('is-selected'));
  }

  _toggleCompactHistory() {
    this._historyCompact = !this._historyCompact;
    const panel = this.element?.querySelector('.npc-panel-history');
    if (panel) panel.classList.toggle('is-compact', this._historyCompact);
    const btn = this.element?.querySelector('.history-compact-btn');
    if (btn) btn.setAttribute('aria-pressed', String(this._historyCompact));
  }

  async _clearHistory(event) {
    event?.preventDefault?.();
    if (this.history.length === 0) return;
    const confirmed = await foundry.applications.api.DialogV2.confirm({
      window:      { title: game.i18n.localize('NpcBuilder.ClearHistory.Title') },
      content:     game.i18n.localize('NpcBuilder.ClearHistory.Content'),
      yes:         { label: game.i18n.localize('NpcBuilder.ClearHistory.Confirm'), icon: 'fa-solid fa-trash-can' },
      no:          { label: game.i18n.localize('NpcBuilder.ClearHistory.Cancel') },
      rejectClose: false,
    }).catch(() => false);
    if (!confirmed) return;
    this.history.length = 0;
    this.storage.saveHistory(this.history, MAX_HISTORY);
    this.selectedHistoryId = null;
    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) banner.style.display = 'none';
    this._renderHistory();
  }

  /* ── Generation progress steps ──────────────────────────── */

  _startStepProgression(entryId, steps) {
    if (steps.length <= 1) return;
    let stepIndex = 0;
    const scheduleNext = () => {
      stepIndex++;
      if (stepIndex >= steps.length) {
        this._stepTimers.delete(entryId);
        return;
      }
      const timer = setTimeout(() => {
        const el = this.element?.querySelector(
          `.history-entry[data-entry-id="${entryId}"] .history-step-label`
        );
        if (el) el.textContent = steps[stepIndex];
        scheduleNext();
      }, 4000);
      this._stepTimers.set(entryId, timer);
    };
    scheduleNext();
  }

  _clearStepTimer(entryId) {
    const timer = this._stepTimers.get(entryId);
    if (timer != null) {
      clearTimeout(timer);
      this._stepTimers.delete(entryId);
    }
  }

  /* ── Generate (delegates to adapter) ────────────────────── */

  async _generate(event) {
    event?.preventDefault?.();

    if (!this.authenticated) {
      ui.notifications.warn(game.i18n.localize('NpcBuilder.Generate.NotSignedIn'));
      return;
    }
    if (this.activeTab === 'home') return;
    if (this.history.some(e => e.status === 'generating')) {
      ui.notifications.warn(game.i18n.localize('NpcBuilder.Generate.AlreadyInProgress'));
      return;
    }

    const form = this.element?.querySelector?.('.npc-form');
    if (!form) {
      ui.notifications.error(game.i18n.localize('NpcBuilder.Generate.FormNotFound'));
      return;
    }

    let formData;
    try {
      formData = this.adapter.gatherFormData(form);
    } catch (err) {
      ui.notifications.warn(err.message);
      return;
    }

    const key = this.accessKey || this.storage.getKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error(game.i18n.localize('NpcBuilder.Session.Missing'));
      return;
    }

    const list    = this.element?.querySelector('.history-list');
    const emptyEl = list?.querySelector('.history-empty');
    if (emptyEl) emptyEl.remove();

    const banner = this.element?.querySelector('.history-selected-banner');
    if (banner) banner.style.display = 'none';
    this.selectedHistoryId = null;
    this.element?.querySelectorAll('.history-entry.is-selected').forEach(el => el.classList.remove('is-selected'));

    const historyEntry = {
      id:        foundry.utils.randomID(16),
      ...this.adapter.historyEntryFromForm(formData),
      status:    'generating',
      createdAt: Date.now(),
      error:     null,
    };
    this.history.push(historyEntry);

    if (list) {
      const newEl = this._createHistoryEntryElement(historyEntry);
      newEl.classList.add('is-new');
      list.insertBefore(newEl, list.firstChild);
      newEl.focus();
    }
    this._startStepProgression(historyEntry.id, this.adapter.progressSteps);

    this.storage.saveHistory(this.history, MAX_HISTORY);
    this.element?.classList.add('is-generating');

    this._runGeneration(historyEntry, key, formData);
  }

  async _runGeneration(historyEntry, key, formData) {
    try {
      const result = await this.adapter.generate({
        formData,
        key,
        devMode: isDevMode(this.moduleFolder),
        builderApp: this,
      });

      // result: { document, exportData?, message? }
      this.lastDocument   = result.document || null;
      this.lastExportData = result.exportData || null;

      this._updateHistoryEntry(historyEntry.id, { status: 'success' });
      this._applyAuthStateUI();

      const docName = result.document?.name || formData.name || 'document';
      ui.notifications.success(result.message || game.i18n.format('NpcBuilder.Generate.Success', { name: docName }));

      const quickFields = result.document ? this.adapter.quickEditFields(result.document) : null;
      if (quickFields?.length) {
        await this._showQuickEditDialog(result.document, quickFields);
      } else {
        try { result.document?.sheet?.render(true); } catch (_) {}
      }

    } catch (err) {
      console.error('[NPC Builder] generation error:', err);
      if (err instanceof AuthError) {
        this.storage.setKey('');
        this.accessKey     = '';
        this.authenticated = false;
        this._applyAuthStateUI();
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: game.i18n.localize('NpcBuilder.Auth.Failed') });
        ui.notifications.error(err.message || game.i18n.localize('NpcBuilder.Auth.Failed'), { permanent: true });
        setTimeout(() => window.open(PATREON_URL, '_blank'), 800);
      } else if (err instanceof RateLimitError) {
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: 'Rate limit exceeded' });
        if (err.tier) this.patreonTier = err.tier;
        let msg = err.message || 'Monthly limit reached.';
        if (err.resetAt) {
          const daysLeft = Math.max(1, Math.ceil((err.resetAt - Date.now()) / 86400000));
          msg += ` Resets in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}.`;
        }
        ui.notifications.error(msg, { permanent: true });
        setTimeout(() => window.open(PATREON_URL, '_blank'), 1200);
      } else if (err instanceof ActorCreationError) {
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: err.message });
        ui.notifications.error(game.i18n.format('NpcBuilder.Create.Failed', { name: formData.name || 'document', error: err.message }));
        if (err.rawData) {
          foundry.applications.api.DialogV2.confirm({
            window:      { title: game.i18n.localize('NpcBuilder.RawData.Title') },
            content:     game.i18n.localize('NpcBuilder.RawData.Content'),
            yes:         { label: game.i18n.localize('NpcBuilder.RawData.Confirm'), icon: 'fa-solid fa-download' },
            no:          { label: game.i18n.localize('NpcBuilder.RawData.Cancel') },
            rejectClose: false,
          }).then(confirmed => {
            if (confirmed) this._triggerJsonDownload(err.rawData, formData.name || 'document');
          }).catch(() => {});
        }
        this._autoReportError(err, formData).catch(() => {});
      } else {
        this._updateHistoryEntry(historyEntry.id, { status: 'error', error: err.message });
        ui.notifications.error(game.i18n.format('NpcBuilder.Create.Failed', { name: formData.name || 'document', error: err.message }));
        this._autoReportError(err, formData).catch(() => {});
      }
    }
  }

  async _showQuickEditDialog(document, fields) {
    const inputs = fields.map(f => {
      const val = f.type === 'number' ? (f.value ?? 0) : escapeHtml(String(f.value ?? ''));
      const numAttrs = f.type === 'number'
        ? ` min="${f.min ?? ''}" max="${f.max ?? ''}" step="${f.step ?? 'any'}"`
        : '';
      return `
        <div class="npc-quick-edit-field">
          <label for="qe-${escapeHtml(f.key)}" class="npc-quick-edit-label">${escapeHtml(f.label)}</label>
          <input id="qe-${escapeHtml(f.key)}" data-key="${escapeHtml(f.key)}"
            type="${f.type || 'text'}" value="${val}"${numAttrs}
            class="npc-quick-edit-input" />
        </div>`;
    }).join('');

    const content = `
      <div class="npc-builder-dialog-body">
        <p class="npc-builder-dialog-hint">${game.i18n.localize('NpcBuilder.QuickEdit.Hint')}</p>
        ${inputs}
      </div>`;

    const updates = await foundry.applications.api.DialogV2.prompt({
      window:      { title: game.i18n.format('NpcBuilder.QuickEdit.Title', { name: escapeHtml(document.name) }) },
      content,
      ok: {
        label:    game.i18n.localize('NpcBuilder.QuickEdit.Confirm'),
        icon:     'fa-solid fa-check',
        callback: (_event, _button, dialog) => {
          const result = {};
          dialog.element.querySelectorAll('[data-key]').forEach(el => {
            result[el.dataset.key] = el.type === 'number' ? Number(el.value) : el.value;
          });
          return result;
        },
      },
      rejectClose: false,
    }).catch(() => null);

    if (updates) {
      const hasChange = fields.some(f => updates[f.key] !== f.value);
      if (hasChange) {
        try { await document.update(updates); } catch (err) {
          console.error('[NPC Builder] Quick-edit update failed:', err);
        }
      }
    }
    try { document.sheet?.render(true); } catch (_) {}
  }

  async _autoReportError(err, formData) {
    const context = JSON.stringify({
      name:   formData?.name,
      level:  formData?.level,
    });
    const message = `[Auto-Error] ${err.name || 'Error'}: ${err.message}\n\nForm context: ${context}`;
    const tier = this.patreonTier || (this.authenticated ? 'Supporter (tier unknown)' : 'Free');
    await sendFeedback({
      message,
      moduleLabel: this.adapter.module.label,
      email:       game.user?.email || '',
      tier,
      sessionKey:  this.accessKey || '',
      devMode:     isDevMode(this.moduleFolder),
      type:        'auto-error',
      consoleLog:  getConsoleLog(),
    });
  }

  _resubmit(sourceEntry) {
    if (!this.authenticated) {
      ui.notifications.warn(game.i18n.localize('NpcBuilder.Generate.NotSignedIn'));
      return;
    }

    const key = this.accessKey || this.storage.getKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error(game.i18n.localize('NpcBuilder.Session.Missing'));
      return;
    }

    const historyEntry = {
      id:        foundry.utils.randomID(16),
      ...this.adapter.historyEntryFromForm(sourceEntry),
      status:    'generating',
      createdAt: Date.now(),
      error:     null,
    };

    this.history.push(historyEntry);
    this.storage.saveHistory(this.history, MAX_HISTORY);

    const list = this.element?.querySelector('.history-list');
    if (list) {
      const emptyEl = list.querySelector('.history-empty');
      if (emptyEl) emptyEl.remove();
      const newEntry = this._createHistoryEntryElement(historyEntry);
      newEntry.classList.add('is-new');
      list.insertBefore(newEntry, list.firstChild);
      newEntry.focus();
    }
    this.element?.classList.add('is-generating');
    this._startStepProgression(historyEntry.id, this.adapter.progressSteps);

    this._runGeneration(historyEntry, key, sourceEntry);
  }

  /* ── Undo last generation ───────────────────────────────── */

  async _undoLastGeneration(event) {
    event?.preventDefault?.();
    if (!this.lastDocument) {
      ui.notifications.warn(game.i18n.localize('NpcBuilder.Undo.None'));
      return;
    }
    const name = this.lastDocument.name || 'document';
    try {
      await this.lastDocument.delete();
    } catch (err) {
      ui.notifications.error(game.i18n.format('NpcBuilder.Undo.Failed', { name, error: err.message }));
      return;
    }
    this.lastDocument   = null;
    this.lastExportData = null;

    let lastSuccessIdx = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].status === 'success') { lastSuccessIdx = i; break; }
    }
    if (lastSuccessIdx !== -1) {
      this.history.splice(lastSuccessIdx, 1);
      this.storage.saveHistory(this.history, MAX_HISTORY);
      this._renderHistory();
    }
    this._applyAuthStateUI();
    ui.notifications.info(game.i18n.format('NpcBuilder.Undo.Deleted', { name }));
  }

  /* ── Name suggestions ───────────────────────────────────── */

  _suggestName() {
    const desc      = this.element?.querySelector('[name="description"]')?.value || '';
    const nameInput = this.element?.querySelector('[name="name"]');
    if (!nameInput) return;
    nameInput.value = generateThematicName(desc);
    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /* ── Offline detection ──────────────────────────────────── */

  _initOfflineDetection() {
    const update = () => {
      this._isOffline = !navigator.onLine;
      this._updateOfflineBanner(this._isOffline);
    };
    window.addEventListener('online',  update);
    window.addEventListener('offline', update);
    this._updateOfflineBanner(this._isOffline);
  }

  _updateOfflineBanner(offline) {
    const banner = this.element?.querySelector('.offline-banner');
    if (banner) banner.style.display = offline ? 'flex' : 'none';
    this._applyAuthStateUI();
  }

  /* ── Session pre-validation ─────────────────────────────── */

  async _validateSessionOnOpen() {
    if (!this.authenticated || !this.accessKey) return;
    const valid = await validateSessionKey(this.accessKey, isDevMode(this.moduleFolder));
    if (!valid && this.element?.isConnected) {
      this.storage.setKey('');
      this.accessKey     = '';
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications?.warn?.(game.i18n.localize('NpcBuilder.Session.Expired'), { permanent: true });
    }
  }

  /* ── Export ─────────────────────────────────────────────── */

  _triggerJsonDownload(data, name) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${String(name).replace(/[^a-z0-9_-]/gi, '_')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async _export(event) {
    event?.preventDefault?.();
    if (!this.lastExportData) {
      ui.notifications.warn(game.i18n.format('NpcBuilder.Export.None', { noun: this.adapter.formConfig.documentNoun || 'document' }));
      return;
    }
    const { content, filename, mimeType } = this.lastExportData;
    const blob = new Blob([content], { type: mimeType || 'application/octet-stream' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = filename || 'export';
    a.click();
    URL.revokeObjectURL(url);
    ui.notifications.info(game.i18n.format('NpcBuilder.Export.Done', { filename }));
  }

  /* ── Image generation ───────────────────────────────────── */

  async _generateImage(event, npcDataOverride, systemOverride) {
    event?.preventDefault?.();

    if (!this.authenticated) {
      ui.notifications.warn(game.i18n.localize('NpcBuilder.ImageGen.NotSignedIn'));
      return;
    }

    const npcData = npcDataOverride || this.lastDocument?.toObject?.() || this.lastDocument;
    if (!npcData) {
      ui.notifications.warn(game.i18n.format('NpcBuilder.ImageGen.NoNpc', { noun: this.adapter.formConfig?.documentNoun || 'document' }));
      return;
    }

    if (!this.adapter.supportsImageGeneration) {
      ui.notifications.warn(game.i18n.localize('NpcBuilder.ImageGen.NotSupported'));
      return;
    }

    const targetSystem = systemOverride || this.adapter.systemId;
    const artStyle     = this.storage.getArtStyle();

    const confirmed = await this._confirmImageGeneration(npcData.name || 'this NPC', artStyle);
    if (!confirmed) return;

    const key = this.accessKey || this.storage.getKey() || '';
    if (!key) {
      this.authenticated = false;
      this._applyAuthStateUI();
      ui.notifications.error(game.i18n.localize('NpcBuilder.Session.Missing'));
      return;
    }

    ui.notifications.info(game.i18n.localize('NpcBuilder.ImageGen.Generating'));

    try {
      const { savedPath } = await generateImage({
        npcData,
        system:   targetSystem,
        artStyle,
        key,
        devMode:  isDevMode(this.moduleFolder),
        onAuthFailed: () => {
          this.storage.setKey('');
          this.accessKey     = '';
          this.authenticated = false;
          this._applyAuthStateUI();
        },
      });

      const docId = npcData._id;
      const doc   = docId ? (game.actors?.get(docId) ?? game.items?.get(docId)) : null;

      if (savedPath && doc) {
        const update = { img: savedPath };
        if (doc.documentName === 'Actor') update['prototypeToken.texture.src'] = savedPath;
        await doc.update(update);
        ui.notifications.success(game.i18n.format('NpcBuilder.ImageGen.SetSuccess', { name: doc.name }));
      } else if (savedPath) {
        ui.notifications.success(game.i18n.format('NpcBuilder.ImageGen.SavedSuccess', { path: savedPath }));
      } else {
        ui.notifications.success(game.i18n.localize('NpcBuilder.ImageGen.SentSuccess'));
      }
    } catch (err) {
      console.error('[NPC Builder] image generation error:', err);
      ui.notifications.error(game.i18n.format('NpcBuilder.ImageGen.Failed', { error: err.message }));
    }
  }

  async _confirmImageGeneration(name, artStyle) {
    const content = `
      <div class="npc-builder-dialog-body">
        <p>${game.i18n.format('NpcBuilder.ImageConfirm.ForName', { name: escapeHtml(name) })}</p>
        <p class="npc-builder-cost-note">
          <i class="fa-solid fa-coins npc-builder-cost-icon"></i>
          ${game.i18n.format('NpcBuilder.ImageConfirm.CostNote', { cost: IMAGE_COST })}
        </p>
        ${artStyle ? `<p class="npc-builder-art-note"><i class="fa-solid fa-palette"></i> ${game.i18n.format('NpcBuilder.ImageConfirm.ArtStyle', { style: escapeHtml(artStyle) })}</p>` : ''}
      </div>`;

    const result = await foundry.applications.api.DialogV2.confirm({
      window:      { title: game.i18n.localize('NpcBuilder.ImageGen.Title') },
      content,
      yes:         { label: game.i18n.localize('NpcBuilder.ImageGen.Confirm'), icon: 'fa-solid fa-image' },
      no:          { label: game.i18n.localize('NpcBuilder.ImageGen.Cancel') },
      rejectClose: false,
    }).catch(() => false);
    return result === true;
  }

  /* ── Feedback ───────────────────────────────────────────── */

  async _sendFeedback(event) {
    event?.preventDefault?.();
    const root = this.element;
    if (!root) return;

    const textarea = root.querySelector('.feedback-textarea');
    const sendBtn  = root.querySelector('.feedback-send-btn');
    const status   = root.querySelector('.feedback-status');

    const message = textarea?.value?.trim() || '';
    if (!message) {
      ui.notifications?.warn?.(game.i18n.localize('NpcBuilder.Feedback.MissingMessage'));
      return;
    }

    if (sendBtn) sendBtn.disabled = true;

    try {
      const tier = this.patreonTier || (this.authenticated ? 'Supporter (tier unknown)' : 'Free');
      await sendFeedback({
        message,
        moduleLabel: this.adapter.module.label,
        email:       game.user?.email || '',
        tier,
        sessionKey:  this.accessKey || '',
        devMode:     isDevMode(this.moduleFolder),
      });

      if (textarea) textarea.value = '';
      if (status) {
        status.textContent   = game.i18n.localize('NpcBuilder.Feedback.Success');
        status.className     = 'feedback-status feedback-status--success';
        status.style.display = '';
        setTimeout(() => { status.style.display = 'none'; }, 4000);
      }
    } catch (err) {
      console.error('[NPC Builder] feedback send error:', err);
      if (status) {
        status.textContent   = game.i18n.localize('NpcBuilder.Feedback.Failed');
        status.className     = 'feedback-status feedback-status--error';
        status.style.display = '';
        setTimeout(() => { status.style.display = 'none'; }, 5000);
      }
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  }
}

/* ============================================================================
   Per-module ApplicationV2 subclass factory.

   ApplicationV2 + HandlebarsApplicationMixin require `static PARTS` and a
   `static DEFAULT_OPTIONS` with `id` + `window.title` + `classes` set on the
   class itself — not on the instance. Since BuilderApp is shared across
   modules, we build a thin subclass per module folder that bakes the right
   template path and titles in, then instantiate that.
   ============================================================================ */

const _appClasses   = new Map();
const _appInstances = new Map();

function getAppClass(adapter) {
  const folder = adapter.moduleFolder;
  let cls = _appClasses.get(folder);
  if (cls) return cls;

  const templatePath = `modules/${folder}/templates/builder.html`;
  const baseClasses  = BuilderApp.DEFAULT_OPTIONS.classes || ['npc-builder'];

  cls = class extends BuilderApp {
    static PARTS = {
      form: { template: templatePath },
    };

    static DEFAULT_OPTIONS = foundry.utils.mergeObject(
      BuilderApp.DEFAULT_OPTIONS,
      {
        id:      `${folder}-app`,
        classes: [...baseClasses, `module-${folder}`],
        window:  { title: `${adapter.module.label} Builder` },
      },
      { inplace: false }
    );
  };

  // Name the class for easier debugging in the Foundry console.
  try { Object.defineProperty(cls, 'name', { value: `BuilderApp_${folder}` }); } catch (_) {}

  _appClasses.set(folder, cls);
  return cls;
}

export function openBuilder(adapter, options = {}) {
  const { initialTab } = options;
  const AppClass = getAppClass(adapter);
  let app = _appInstances.get(adapter.moduleFolder);
  if (app?.rendered && app?.element?.isConnected) {
    // Reopening always lands on the builder form (unless Home is explicitly
    // requested) so the builder never re-opens stuck on the Home tab.
    app.activeTab = initialTab === 'home' ? 'home' : 'builder';
    app._applyTabUI?.();
    app.bringToTop?.();
  } else {
    app = new AppClass(adapter, { initialTab });
    _appInstances.set(adapter.moduleFolder, app);
    app.render({ force: true }).catch(err => {
      console.error('[NPC Builder] Failed to open:', err);
      ui.notifications?.error?.('Builder failed to open. Check the console (F12) for details.');
      _appInstances.delete(adapter.moduleFolder);
    });
  }
  return app;
}

/** Returns an instance for sheet button callbacks (does not render the window). */
export function ensureBuilder(adapter) {
  const AppClass = getAppClass(adapter);
  let app = _appInstances.get(adapter.moduleFolder);
  if (!app?.rendered || !app?.element?.isConnected) {
    app = new AppClass(adapter);
    _appInstances.set(adapter.moduleFolder, app);
  }
  app.accessKey     = app.storage.getKey() || '';
  app.authenticated = !!app.accessKey;
  return app;
}

export { ALL_MODULES, getModuleMeta, detectModuleFolder, IMAGE_COST };
