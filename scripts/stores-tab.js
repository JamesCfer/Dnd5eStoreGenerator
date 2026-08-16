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
  try {
    CONFIG.ui.stores = StoresTab;
    const SidebarCls = foundry.applications.sidebar?.Sidebar;
    const tabs = SidebarCls?.TABS ?? SidebarCls?.prototype?.TABS;
    if (tabs && !tabs.stores) tabs.stores = { tooltip: 'Stores', icon: 'fa-solid fa-shop' };
  } catch (err) {
    console.error(`[${MODULE_ID}] failed to register the Stores tab`, err);
  }
}

/**
 * Make sure the tab actually exists once the UI is up. Foundry v13 builds
 * ui.* from CONFIG.ui, but v14 does not adopt entries added by modules —
 * so if core didn't instantiate our tab, mount it ourselves and re-render
 * the sidebar so the rail picks up the button.
 */
export function ensureStoresTab() {
  try {
    registerStoresTab();
    if (!ui.stores && CONFIG.ui.stores) {
      ui.stores = new CONFIG.ui.stores();
      console.info(`[${MODULE_ID}] Stores tab mounted manually (core did not adopt CONFIG.ui.stores).`);
    }
    if (ui.stores && !ui.stores.rendered) ui.sidebar?.render();
  } catch (err) {
    console.error(`[${MODULE_ID}] failed to mount the Stores tab`, err);
  }
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
