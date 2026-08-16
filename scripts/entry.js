/**
 * D&D Store Generator — module entry point.
 * Registers in the Items and Journal directories since the output is a
 * store journal plus a folder of inventory items.
 */

import { openBuilder, ensureBuilder } from './core/app.js';
import { checkForModuleUpdate } from './core/update-check.js';
import { registerSidebar }      from './core/sidebar.js';
import { startHeartbeat }       from './core/heartbeat.js';
import { Storage }              from './core/storage.js';
import { Dnd5eStoreAdapter }    from './adapter.js';
import { StoreSheet, getStore, migrateLegacyStore, openStoreSheet } from './store-sheet.js';
import { registerStoreSockets } from './transactions.js';
import { StoresTab, registerStoresTab, registerStoresTabHooks, ensureStoresTab } from './stores-tab.js';

const adapter   = new Dnd5eStoreAdapter();
const MODULE_ID = adapter.module.id;

// Intercept JournalEntry sheet rendering — journals carrying a store flag
// (or recognizable as legacy generated stores) open the custom store sheet
// instead of the stock journal sheet. Sheet classes vary by core version and
// system (JournalSheet, JournalEntrySheet, JournalSheetPF2e, …), so listen on
// the base-class render hooks too; render hooks fire for every class in the
// inheritance chain, and openStoreSheet dedupes repeat calls per journal.
const swapToStoreSheet = (app) => {
  try {
    if (app instanceof StoreSheet) return;
    const journal = app?.document;
    if (!(journal instanceof JournalEntry)) return;
    let store = getStore(journal);
    if (!store) {
      store = migrateLegacyStore(journal);
      if (!store) return;
      if (game.user.isGM) journal.setFlag(MODULE_ID, 'store', store).catch(() => {});
    }
    // Defer the swap so we don't recurse during render.
    app.close({ submit: false });
    queueMicrotask(() => openStoreSheet(journal));
  } catch (err) {
    console.error(`[${MODULE_ID}] store sheet swap failed`, err);
  }
};
Hooks.on('renderJournalSheet', swapToStoreSheet);       // AppV1 leaf (v12) + subclasses
Hooks.on('renderJournalEntrySheet', swapToStoreSheet);  // AppV2 leaf (v13+)
Hooks.on('renderDocumentSheet', swapToStoreSheet);      // AppV1 base — any system subclass
Hooks.on('renderDocumentSheetV2', swapToStoreSheet);    // AppV2 base — any system subclass

const openFn = () => {
  openBuilder(adapter);
  checkForModuleUpdate(MODULE_ID, adapter.module.githubUrl).catch(() => {});
};

adapter.registerSheetHooks(() => ensureBuilder(adapter));

registerSidebar(MODULE_ID, openFn, {
  buttonLabel: 'Store Generator',
  buttonIcon:  adapter.module.icon,
  directories: ['items', 'journal', 'compendium'],
});

class ResetWelcomeMessageMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    foundry.applications.api.DialogV2.confirm({
      window:      { title: game.i18n.localize('NpcBuilder.Settings.ResetWelcome.Name') },
      content:     `<p>${game.i18n.localize('NpcBuilder.Settings.ResetWelcome.ConfirmContent')}</p>`,
      yes:         { label: game.i18n.localize('NpcBuilder.Settings.ResetWelcome.ConfirmLabel'), icon: 'fa-solid fa-rotate-left' },
      no:          { label: 'Cancel' },
      rejectClose: false,
    }).then(ok => {
      if (ok) {
        game.settings.set(MODULE_ID, 'welcomeMessageShown', false);
        ui.notifications.info(game.i18n.localize('NpcBuilder.Settings.ResetWelcome.Success'));
      }
    }).catch(() => {});
    return this;
  }
}

class ClearSessionMenu extends foundry.applications.api.ApplicationV2 {
  render() {
    foundry.applications.api.DialogV2.confirm({
      window:      { title: game.i18n.localize('NpcBuilder.Settings.ClearSession.Name') },
      content:     `<p>${game.i18n.localize('NpcBuilder.Settings.ClearSession.ConfirmContent')}</p>`,
      yes:         { label: game.i18n.localize('NpcBuilder.Settings.ClearSession.ConfirmLabel'), icon: 'fa-solid fa-right-from-bracket' },
      no:          { label: 'Cancel' },
      rejectClose: false,
    }).then(ok => {
      if (ok) {
        new Storage(MODULE_ID).setKey('');
        ui.notifications.info(game.i18n.localize('NpcBuilder.Settings.ClearSession.Success'));
      }
    }).catch(() => {});
    return this;
  }
}

Hooks.once('init', () => {
  registerStoresTab();

  game.settings.register(MODULE_ID, 'devMode', {
    name:   'Developer Mode',
    hint:   'When enabled, all webhook URLs are routed to the -dev endpoints. Disable before going live.',
    scope:  'world', config: true, type: Boolean, default: false,
  });

  game.settings.register(MODULE_ID, 'welcomeMessageShown', {
    scope:  'world', config: false, type: Boolean, default: false,
  });

  game.settings.registerMenu(MODULE_ID, 'resetWelcome', {
    name:       'NpcBuilder.Settings.ResetWelcome.Name',
    label:      'NpcBuilder.Settings.ResetWelcome.Label',
    hint:       'NpcBuilder.Settings.ResetWelcome.Hint',
    icon:       'fa-solid fa-rotate-left',
    type:       ResetWelcomeMessageMenu,
    restricted: true,
  });

  game.settings.registerMenu(MODULE_ID, 'clearSession', {
    name:       'NpcBuilder.Settings.ClearSession.Name',
    label:      'NpcBuilder.Settings.ClearSession.Label',
    hint:       'NpcBuilder.Settings.ClearSession.Hint',
    icon:       'fa-solid fa-right-from-bracket',
    type:       ClearSessionMenu,
    restricted: true,
  });
});

Hooks.once('ready', () => {
  const mod = game.modules?.get(MODULE_ID);
  const currentVersion = mod?.version || '';

  const storage = new Storage(MODULE_ID);
  const storedVersion = storage.getVersion();

  if (currentVersion && storedVersion && currentVersion !== storedVersion) {
    storage.setKey('');
    ui.notifications?.info?.('Store Generator was updated — please sign in again.');
  }
  if (currentVersion) storage.setVersion(currentVersion);

  foundry.applications.handlebars.loadTemplates([
    `modules/${MODULE_ID}/templates/builder.html`,
  ]);
  console.log(`D&D Store Generator ready (version: ${currentVersion}).`);

  startHeartbeat(MODULE_ID);
  registerStoreSockets();
  StoresTab.openGenerator = openFn;
  ensureStoresTab();
  registerStoresTabHooks();

  const module = game.modules.get(MODULE_ID);
  if (module) module.api = {
    StoreSheet,
    openStoreSheet,
    open: (nameOrId) => {
      const j = game.journal.get(nameOrId) || game.journal.getName(nameOrId);
      if (!j) return ui.notifications.warn(`No journal named "${nameOrId}".`);
      const store = getStore(j) || migrateLegacyStore(j);
      if (!store) return ui.notifications.warn(`"${j.name}" does not look like a generated store.`);
      if (!getStore(j) && game.user.isGM) j.setFlag(MODULE_ID, 'store', store).catch(() => {});
      return openStoreSheet(j);
    },
  };

  if (game.user.isGM && !game.settings.get(MODULE_ID, 'welcomeMessageShown')) {
    const welcomeContent = `
<h3>Welcome to the D&D Store Generator!</h3>
<p>The generator has opened automatically — you're ready to start generating stores right away.</p>
<p>Each store costs <strong>7 uses</strong> and creates a store journal plus a folder of stocked inventory items.</p>
<p>You can reopen it any time from the <em>Store Generator</em> button in the <strong>Items</strong>, <strong>Journal</strong>, or <strong>Compendium</strong> sidebar header.</p>`.trim();

    ChatMessage.create({
      content: welcomeContent,
      whisper: game.users.filter(u => u.isGM).map(u => u.id),
    });
    game.settings.set(MODULE_ID, 'welcomeMessageShown', true);
    openBuilder(adapter);
    checkForModuleUpdate(MODULE_ID, adapter.module.githubUrl).catch(() => {});
  }
});
