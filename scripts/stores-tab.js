/**
 * StoresTab — a dedicated sidebar category for store journals.
 *
 * Registered in entry.js via CONFIG.ui.stores + Sidebar.TABS.stores (the same
 * mechanism core uses for its own tabs on Foundry v13 and v14). Store journals
 * are listed here instead of the Journal directory; clicking one adopts it if
 * needed and opens the custom store sheet.
 */

import { getStore, isStoreJournal, adoptAndOpenStore, STORE_TYPE_LABELS } from './store-sheet.js';

const MODULE_ID = 'Dnd5eStoreGenerator';

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { AbstractSidebarTab } = foundry.applications.sidebar;

export class StoresTab extends HandlebarsApplicationMixin(AbstractSidebarTab) {
  static tabName = 'stores';

  /** Set by entry.js so the tab's Generate button opens the builder. */
  static openGenerator = null;

  static DEFAULT_OPTIONS = {
    window: { title: 'Stores' },
    actions: {
      openStore:     function(ev) { this._onOpenStore(ev); },
      openGenerator: function()   { StoresTab.openGenerator?.(); },
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/stores-tab.hbs` },
  };

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    context.stores = game.journal
      .filter(j => j.visible && isStoreJournal(j))
      .map(j => {
        const s = getStore(j) || {};
        const ownerActor = s.owner?.actorId ? game.actors.get(s.owner.actorId) : null;
        return {
          id:        j.id,
          name:      j.name,
          img:       ownerActor?.img || s.inventory?.[0]?.img || 'icons/svg/item-bag.svg',
          typeLabel: STORE_TYPE_LABELS[s.storeType] || 'Store',
          ownerName: s.owner?.name || '',
          closed:    !!s.closed,
          itemCount: (s.inventory || []).length,
          orders:    (s.orders || []).length,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    context.isGM = game.user.isGM;
    return context;
  }

  _onOpenStore(ev) {
    const id = ev.target.closest('[data-journal-id]')?.dataset?.journalId;
    const journal = id ? game.journal.get(id) : null;
    if (!journal) return;
    if (!adoptAndOpenStore(journal)) journal.sheet.render(true);
  }
}

/** Register the tab with the sidebar. Call from the init hook. */
export function registerStoresTab() {
  CONFIG.ui.stores = StoresTab;
  foundry.applications.sidebar.Sidebar.TABS.stores = {
    tooltip: 'Stores',
    icon:    'fa-solid fa-shop',
  };
}

/** Keep the tab live and the Journal directory free of store entries. */
export function registerStoresTabHooks() {
  const refresh = () => { if (ui.stores?.rendered) ui.stores.render(); };
  Hooks.on('createJournalEntry', refresh);
  Hooks.on('updateJournalEntry', refresh);
  Hooks.on('deleteJournalEntry', refresh);

  // Store journals live in the Stores tab — drop them from the Journal directory.
  Hooks.on('renderJournalDirectory', (_app, html) => {
    const root = html instanceof HTMLElement ? html : html?.[0];
    if (!root) return;
    root.querySelectorAll('li.directory-item[data-entry-id]').forEach(li => {
      const journal = game.journal.get(li.dataset.entryId);
      if (journal && isStoreJournal(journal)) li.remove();
    });
  });
}
