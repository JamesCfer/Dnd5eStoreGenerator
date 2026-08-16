/**
 * StoreSheet — D&D 5e-themed custom sheet for store JournalEntries.
 * ApplicationV2 + HandlebarsApplicationMixin.
 *
 * Data lives in flags.Dnd5eStoreGenerator.store; every mutation goes through
 * doc.setFlag and the sheet re-renders. Inventory rows carry item UUIDs plus
 * a display snapshot (name/img/rarity/price) so players without item
 * permissions still see the storefront.
 *
 * Drag & drop:
 *  - rows are draggable out (standard {type:'Item', uuid} payload → actor sheets)
 *  - world/compendium items can be dropped onto the inventory to stock them
 *  - a compendium browser pulls dnd5e system items filtered by store type,
 *    capped by the store's wealth tier
 */

import { priceToCp, cpLabel, effectiveCp, orderFeePct, parsePriceLabelCp, requestTransaction } from './transactions.js';

import { postToN8n } from './core/adapter.js';
import { Storage } from './core/storage.js';
import { N8N_BASE, devUrl, isDevMode } from './core/n8n.js';
import { sanitizeItemDataDnd5e } from './sanitizer.js';

const MODULE_ID = 'Dnd5eStoreGenerator';
const WIKI_ENDPOINT = `${N8N_BASE}/webhook/dnd5e-wiki-item`;
const WIKI_SEARCH_ENDPOINT = `${N8N_BASE}/webhook/dnd5e-wiki-search`;
const FLAG_KEY  = 'store';

const { HandlebarsApplicationMixin, ApplicationV2 } = foundry.applications.api;

export const STORE_TYPE_LABELS = {
  general:      'General Goods',
  blacksmith:   'Blacksmith / Weaponsmith',
  armorer:      'Armorer',
  alchemist:    'Alchemist / Apothecary',
  magic:        'Magic Shop',
  jeweler:      'Jeweler / Curiosities',
  fletcher:     'Fletcher / Bowyer',
  tavern:       'Tavern / Inn',
};

const RARITY_RANK = { '': 0, common: 1, uncommon: 2, rare: 3, veryRare: 4, legendary: 5, artifact: 6 };
const WEALTH_RARITY_CAP = { poor: 0, modest: 1, wealthy: 3, aristocratic: 4 };

const RARITY_LABELS = {
  common: 'Common', uncommon: 'Uncommon', rare: 'Rare',
  veryRare: 'Very Rare', legendary: 'Legendary', artifact: 'Artifact',
};

/* dnd5e moved weapon/armor/consumable subtype between versions — read both. */
function weaponSubtype(entry)     { return entry.system?.type?.value ?? entry.system?.weaponType ?? ''; }
function armorSubtype(entry)      { return entry.system?.type?.value ?? entry.system?.armor?.type ?? ''; }
function consumableSubtype(entry) { return entry.system?.type?.value ?? entry.system?.consumableType ?? ''; }

/** Does a compendium index entry fit the store type's shelves? */
function matchesStoreType(entry, storeType) {
  const type   = entry.type;
  const rarity = String(entry.system?.rarity || '');

  switch (storeType) {
    case 'blacksmith': return type === 'weapon' && ['simpleM', 'martialM'].includes(weaponSubtype(entry));
    case 'fletcher':   return (type === 'weapon' && ['simpleR', 'martialR'].includes(weaponSubtype(entry)))
                           || (type === 'consumable' && consumableSubtype(entry) === 'ammo');
    case 'armorer':    return type === 'equipment' && ['light', 'medium', 'heavy', 'shield'].includes(armorSubtype(entry));
    case 'alchemist':  return type === 'consumable' && ['potion', 'poison'].includes(consumableSubtype(entry));
    case 'magic':      return !!rarity;
    case 'jeweler':    return type === 'loot' && !rarity;
    case 'tavern':     return type === 'consumable' && consumableSubtype(entry) === 'food';
    case 'general':
    default:           return ['loot', 'tool', 'container', 'backpack', 'consumable'].includes(type) && !rarity;
  }
}

/** Human-readable price label from a dnd5e price object. */
function priceLabel(price) {
  if (!price || typeof price !== 'object') {
    return Number(price) ? `${Number(price)} gp` : '—';
  }
  const v = Number(price.value) || 0;
  return v ? `${v} ${price.denomination || 'gp'}` : '—';
}

function rarityLabel(rarity) {
  return RARITY_LABELS[rarity] || 'Mundane';
}

/** Build an inventory-entry snapshot from an Item document. */
function snapshotFromItem(item) {
  return {
    uuid:    item.uuid,
    name:    item.name,
    img:     item.img || 'icons/svg/item-bag.svg',
    type:    item.type,
    rarity:  rarityLabel(item.system?.rarity),
    price:   priceLabel(item.system?.price),
    priceCp: priceToCp(item.system?.price),
    qty:     Math.max(1, Number(item.system?.quantity) || 1),
  };
}

/* One sheet instance per journal so repeated hook fire cannot open duplicates. */
const OPEN_SHEETS = new Map();

export function openStoreSheet(journal) {
  let sheet = OPEN_SHEETS.get(journal.id);
  if (!sheet) {
    sheet = new StoreSheet(journal);
    OPEN_SHEETS.set(journal.id, sheet);
  }
  sheet.render(true);
  return sheet;
}

/** Is this journal one of ours — flagged, folder-linked, or a legacy generated store? */
export function isStoreJournal(journal) {
  const flags = journal?.flags?.[MODULE_ID];
  if (flags?.[FLAG_KEY] || flags?.itemFolderId) return true;
  const page = journal?.pages?.find?.(p => p.name === 'Store Overview');
  return !!page && /<h2>\s*(Inventory|Shopkeeper)\s*<\/h2>/i.test(page.text?.content || '');
}

/** Adopt (if legacy) and open a store journal in the store sheet. */
export function adoptAndOpenStore(journal) {
  const store = getStore(journal) || migrateLegacyStore(journal);
  if (!store) return null;
  if (!getStore(journal) && game.user.isGM) journal.setFlag(MODULE_ID, FLAG_KEY, store).catch(() => {});
  return openStoreSheet(journal);
}

export function getStore(doc) {
  return doc?.getFlag?.(MODULE_ID, FLAG_KEY) || null;
}

/** Ordering of type groups on the shelf. */
const TYPE_ORDER = ['weapon', 'equipment', 'consumable', 'tool', 'container', 'backpack', 'loot'];

export class StoreSheet extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: 'dnd5e-store-sheet-{id}',
    classes: ['cfer-store-sheet', 'cfer-store-sheet--dnd5e'],
    tag: 'form',
    window: { resizable: true, contentClasses: ['cfer-store-sheet-window'] },
    position: { width: 860, height: 680 },
    actions: {
      openItem:      function(ev) { this._onOpenItem(ev); },
      removeItem:    function(ev) { this._onRemoveItem(ev); },
      qtyDelta:      function(ev) { this._onQtyDelta(ev); },
      toggleBrowser: function()   { this._onToggleBrowser(); },
      addFromBrowser: function(ev) { this._onAddFromBrowser(ev); },
      restock:       function()   { this._onRestock(); },
      editField:     function(ev) { this._onEditField(ev); },
      openOwnerNote: function()   { this._onEditOwner(); },
      buyItem:       function(ev) { this._onBuyItem(ev); },
      editPrice:     function(ev) { this._onEditPrice(ev); },
      storeSettings: function()   { this._onStoreSettings(); },
      shareStore:    function()   { this._onShareStore(); },
      openOwnerActor: function(ev) { this._onOpenOwnerActor(ev); },
      orderItem:     function(ev) { this._onOrderItem(ev); },
      deliverOrder:  function(ev) { this._onDeliverOrder(ev); },
      cancelOrder:   function(ev) { this._onCancelOrder(ev); },
      fetchWiki:     function()   { this._onFetchWiki(); },
      importWikiRow: function(ev) { this._onImportWikiRow(ev); },
      addStaff:      function()   { this._onEditStaff(null); },
      editStaff:     function(ev) { this._onEditStaff(this._staffIdFromEvent(ev)); },
      removeStaff:   function(ev) { this._onRemoveStaff(ev); },
      generateStaffActor: function(ev) { this._onGenerateStaffActor(ev); },
      openStaffActor: function(ev) { this._onOpenStaffActor(ev); },
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/store-sheet.hbs` },
  };

  constructor(journal, options = {}) {
    super(options);
    this.document = journal;
    this.browserOpen   = false;
    this.browserSearch = '';
    this.browserSource = 'all';
    this.browserAllTypes = false;
    this.browserAnyRarity = false;
    this._browserIndex = null;
  }

  get title() { return this.document?.name || 'Store'; }

  get isEditable() { return !!this.document?.isOwner; }

  /* ── data ───────────────────────────────────────────────── */

  _getStoreClone() {
    return foundry.utils.deepClone(getStore(this.document)) || { inventory: [] };
  }

  async _patch(mutator) {
    const store = this._getStoreClone();
    mutator(store);
    await this.document.setFlag(MODULE_ID, FLAG_KEY, store);
    this.render(false);
  }

  async _prepareContext() {
    const store = this._getStoreClone();
    const mul = Number(store.priceMultiplier) || 1;
    const inventory = (store.inventory || []).map((e, idx) => {
      const cp = effectiveCp(e, store);
      return {
        ...e,
        idx,
        displayPrice: mul === 1 && e.price ? e.price : cpLabel(cp),
        basePrice:    e.price,
        adjusted:     mul !== 1,
      };
    });

    inventory.sort((a, b) => {
      const to = TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type);
      if (to !== 0) return to;
      return String(a.name).localeCompare(String(b.name));
    });

    // Group rows under type headers so the shelf reads sorted by kind.
    const groups = [];
    for (const row of inventory) {
      const label = row.type ? row.type.charAt(0).toUpperCase() + row.type.slice(1) : 'Other';
      let group = groups.find(g => g.label === label);
      if (!group) { group = { label, rows: [] }; groups.push(group); }
      group.rows.push(row);
    }

    let browserRows = [];
    let browserSources = [];
    if (this.browserOpen) {
      browserRows = await this._filteredBrowserRows(store);
      browserSources = await this._browserSourceOptions();
    }

    const ownerActor = store.owner?.actorId ? game.actors.get(store.owner.actorId) : null;

    const staff = (store.staff || []).map(s => {
      const actor = s.actorId ? game.actors.get(s.actorId) : null;
      return { ...s, portrait: actor?.img || null, hasActor: !!actor };
    });

    const orders = (store.orders || []).map(o => ({
      ...o,
      priceLabel: cpLabel(Number(o.priceCp) || 0),
      dateLabel:  o.placedAt ? new Date(o.placedAt).toLocaleDateString() : '',
      isMine:     !!game.user.character && o.buyerUuid === game.user.character.uuid,
    }));

    return {
      doc:            this.document,
      store,
      typeLabel:      STORE_TYPE_LABELS[store.storeType] || 'Store',
      groups,
      itemCount:      inventory.reduce((sum, e) => sum + (Number(e.qty) || 1), 0),
      lineCount:      inventory.length,
      editable:       this.isEditable,
      canTrade:       !store.closed || this.isEditable,
      closed:         !!store.closed,
      priceMulLabel:  Number(store.priceMultiplier) && Number(store.priceMultiplier) !== 1
                        ? `×${Number(store.priceMultiplier)}` : '',
      ownerPortrait:  ownerActor?.img || null,
      staff,
      npcMakerActive: !!game.modules.get('DnD5eNpcMaker')?.active,
      orders,
      orderFee:       orderFeePct(store),
      browserOpen:    this.browserOpen,
      browserSearch:  this.browserSearch,
      browserRows,
      browserSources,
      browserAllTypes: this.browserAllTypes,
      browserAnyRarity: this.browserAnyRarity,
    };
  }

  /* ── lifecycle: live refresh when the journal changes ───── */

  _onFirstRender(context, options) {
    super._onFirstRender?.(context, options);
    this._updateHookId = Hooks.on('updateJournalEntry', doc => {
      if (doc.id === this.document.id) this.render(false);
    });
  }

  _onClose(options) {
    OPEN_SHEETS.delete(this.document?.id);
    if (this._updateHookId) Hooks.off('updateJournalEntry', this._updateHookId);
    super._onClose?.(options);
  }

  /* ── compendium browser ─────────────────────────────────── */

  async _loadBrowserIndex() {
    if (this._browserIndex) return this._browserIndex;
    // Every Item compendium in the world: system, modules (importers included), and world packs.
    const packs = game.packs.filter(p => p.documentName === 'Item');
    const rows = [];
    for (const pack of packs) {
      const index = await pack.getIndex({
        fields: ['img', 'type', 'system.rarity', 'system.price.value', 'system.price.denomination',
                 'system.type.value', 'system.weaponType', 'system.armor.type', 'system.consumableType'],
      }).catch(() => null);
      if (!index) continue;
      for (const e of index) {
        // Skip non-inventory documents that share the Item type (classes, spells, feats…).
        if (!['weapon', 'equipment', 'consumable', 'tool', 'loot', 'container', 'backpack'].includes(e.type)) continue;
        rows.push({ ...e, uuid: e.uuid || `Compendium.${pack.collection}.Item.${e._id}`, pack: pack.collection, packLabel: pack.metadata.label });
      }
    }
    return (this._browserIndex = rows);
  }

  _rarityCap(store) {
    return WEALTH_RARITY_CAP[store.wealth] ?? 1;
  }

  async _filteredBrowserRows(store) {
    const index = await this._loadBrowserIndex();
    const cap = this._rarityCap(store);
    const search = this.browserSearch.trim().toLowerCase();
    if (this.browserSource === '__wiki') {
      let wikiRows = await this._wikiSearchRows();
      if (!this.browserAnyRarity) wikiRows = wikiRows.filter(r => (RARITY_RANK[String(r.rarity || '')] ?? 0) <= cap);
      return wikiRows.map(r => ({ ...r, rarity: r.rarity ? (RARITY_LABELS[r.rarity] || r.rarity) : 'Mundane' }));
    }
    let rows = index;
    if (this.browserSource !== 'all') rows = rows.filter(e => e.pack === this.browserSource);
    if (!this.browserAllTypes) rows = rows.filter(e => matchesStoreType(e, store.storeType || 'general'));
    if (!this.browserAnyRarity) rows = rows.filter(e => (RARITY_RANK[String(e.system?.rarity || '')] ?? 0) <= cap);
    return rows
      .filter(e => !search || e.name.toLowerCase().includes(search))
      .sort((a, b) => (RARITY_RANK[String(a.system?.rarity || '')] ?? 0) - (RARITY_RANK[String(b.system?.rarity || '')] ?? 0) || a.name.localeCompare(b.name))
      .slice(0, 200)
      .map(e => ({
        uuid:   e.uuid,
        name:   e.name,
        img:    e.img || 'icons/svg/item-bag.svg',
        rarity: rarityLabel(e.system?.rarity),
        price:  priceLabel(e.system?.price),
        priceCp: priceToCp(e.system?.price),
        packLabel: e.packLabel,
      }));
  }

  /** Distinct sources present in the index, for the catalog dropdown. */
  async _browserSourceOptions() {
    const index = await this._loadBrowserIndex();
    const seen = new Map();
    for (const e of index) if (!seen.has(e.pack)) seen.set(e.pack, e.packLabel);
    const options = [...seen.entries()]
      .map(([id, label]) => ({ id, label, selected: this.browserSource === id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    options.unshift({ id: '__wiki', label: 'Wiki: 5eTools', selected: this.browserSource === '__wiki' });
    return options;
  }

  /** Server-side wiki catalog search — the relay queries its cached tables. */
  async _wikiSearchRows() {
    const q = this.browserSearch.trim();
    if (q.length < 2) return [];
    if (this._wikiCache?.q === q) return this._wikiCache.rows;
    const key = new Storage(MODULE_ID).getKey();
    if (!key) { ui.notifications.warn('Sign in with Patreon (Store Generator) to browse the wiki catalog.'); return []; }
    try {
      const endpoint = devUrl(WIKI_SEARCH_ENDPOINT, isDevMode(MODULE_ID));
      const { response, responseText } = await postToN8n(endpoint, { query: q }, key);
      const data = JSON.parse(responseText);
      if (!response.ok || data?.ok === false) throw new Error(data?.message || `Server returned ${response.status}`);
      const rows = (data.results || []).map(r => ({
        wiki:   true,
        name:   r.name,
        img:    'icons/svg/book.svg',
        level:  Number(r.level) || 0,
        rarity: r.rarity || '',
        price:  r.price || '—',
        priceCp: Number(r.priceCp) || 0,
        packLabel: data.source || 'Wiki',
      }));
      this._wikiCache = { q, rows };
      return rows;
    } catch (err) {
      ui.notifications.warn(`Wiki search failed: ${err.message}`);
      return [];
    }
  }

  /* ── render / listeners ─────────────────────────────────── */

  _onRender() {
    // Drag rows OUT: standard Foundry payload so actor sheets accept them.
    this.element.querySelectorAll('[data-drag-uuid]').forEach(row => {
      row.addEventListener('dragstart', ev => {
        ev.dataTransfer.setData('text/plain', JSON.stringify({ type: 'Item', uuid: row.dataset.dragUuid }));
        ev.dataTransfer.effectAllowed = 'copy';
      });
    });

    // Drop items IN: GM stocks the shelf; players sell items off their sheet.
    const shelf = this.element.querySelector('.cfer-store-inventory');
    if (shelf) {
      shelf.addEventListener('dragover',  ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'copy'; shelf.classList.add('drag-over'); });
      shelf.addEventListener('dragleave', ()  => shelf.classList.remove('drag-over'));
      shelf.addEventListener('drop',      ev => { shelf.classList.remove('drag-over'); this._onDropItem(ev); });
    }

    // Drop an Actor onto the shopkeeper card to link them.
    const ownerCard = this.element.querySelector('.cfer-store-owner');
    if (ownerCard && this.isEditable) {
      ownerCard.addEventListener('dragover', ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'link'; });
      ownerCard.addEventListener('drop', ev => this._onDropOwnerActor(ev));
    }

    // Drop an Actor onto a staff card to link them.
    this.element.querySelectorAll('.cfer-store-staff-card').forEach(card => {
      if (!this.isEditable) return;
      card.addEventListener('dragover', ev => { ev.preventDefault(); ev.dataTransfer.dropEffect = 'link'; });
      card.addEventListener('drop', async ev => {
        ev.preventDefault(); ev.stopPropagation();
        let data;
        try { data = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
        if (data.type !== 'Actor' || !data.uuid) return;
        const actor = await fromUuid(data.uuid).catch(() => null);
        if (!actor) return;
        const staffId = card.dataset.staffId;
        await this._patch(s => {
          const m = (s.staff || []).find(x => x.id === staffId);
          if (m) { m.actorId = actor.id; m.name = m.name || actor.name; }
        });
      });
    });

    const searchEl = this.element.querySelector('[data-browser-search]');
    if (searchEl) {
      searchEl.addEventListener('input', ev => {
        this.browserSearch = ev.currentTarget.value || '';
        clearTimeout(this._searchTimer);
        this._searchTimer = setTimeout(() => this.render(false), 250);
      });
    }

    const sourceEl = this.element.querySelector('[data-browser-source]');
    if (sourceEl) sourceEl.addEventListener('change', ev => { this.browserSource = ev.currentTarget.value; this.render(false); });
    const allTypesEl = this.element.querySelector('[data-browser-alltypes]');
    if (allTypesEl) allTypesEl.addEventListener('change', ev => { this.browserAllTypes = ev.currentTarget.checked; this.render(false); });
    const anyRarityEl = this.element.querySelector('[data-browser-anyrarity]');
    if (anyRarityEl) anyRarityEl.addEventListener('change', ev => { this.browserAnyRarity = ev.currentTarget.checked; this.render(false); });
  }

  /* ── inventory actions ──────────────────────────────────── */

  async _onOpenItem(ev) {
    const uuid = ev.target.closest('[data-uuid]')?.dataset?.uuid;
    if (!uuid) return;
    const item = await fromUuid(uuid).catch(() => null);
    if (item?.sheet) item.sheet.render(true);
    else ui.notifications.warn('That item no longer exists (it may have been deleted).');
  }

  async _onRemoveItem(ev) {
    if (!this.isEditable) return;
    const uuid = ev.target.closest('[data-uuid]')?.dataset?.uuid;
    if (!uuid) return;
    await this._patch(s => { s.inventory = (s.inventory || []).filter(e => e.uuid !== uuid); });
  }

  async _onQtyDelta(ev) {
    if (!this.isEditable) return;
    const el = ev.target.closest('[data-delta]');
    const uuid = ev.target.closest('[data-uuid]')?.dataset?.uuid;
    if (!el || !uuid) return;
    const delta = Number(el.dataset.delta) || 0;
    await this._patch(s => {
      const entry = (s.inventory || []).find(e => e.uuid === uuid);
      if (entry) entry.qty = Math.max(1, (Number(entry.qty) || 1) + delta);
    });
  }

  async _onDropItem(ev) {
    ev.preventDefault();
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
    if (data.type !== 'Item' || !data.uuid) return;
    const item = await fromUuid(data.uuid).catch(() => null);
    if (!item) return;

    // An item embedded in an actor → offer to SELL it to the store.
    if (item.parent instanceof Actor) {
      if (!item.parent.isOwner) return;
      return this._onSellItem(item);
    }

    if (!this.isEditable) return;
    await this._stockItem(item);
  }

  async _onSellItem(item) {
    const store = this._getStoreClone();
    const rate = Number.isFinite(Number(store.sellRate)) ? Number(store.sellRate) : 0.5;
    const payout = Math.max(0, Math.round(priceToCp(item.system?.price) * rate));
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Sell to ${this.document.name}` },
      content: `<p>Sell <strong>${foundry.utils.escapeHTML(item.name)}</strong> for <strong>${cpLabel(payout)}</strong>?</p>`,
      rejectClose: false,
    }).catch(() => false);
    if (!ok) return;
    await requestTransaction({
      type:        'sell',
      journalUuid: this.document.uuid,
      itemUuid:    item.uuid,
      actorUuid:   item.parent.uuid,
    });
  }

  async _onBuyItem(ev) {
    const uuid = ev.target.closest('[data-uuid]')?.dataset?.uuid;
    if (!uuid) return;
    const store = this._getStoreClone();
    if (store.closed && !this.isEditable) return ui.notifications.warn(`${this.document.name} is closed.`);
    const entry = (store.inventory || []).find(e => e.uuid === uuid);
    if (!entry) return;

    const actor = game.user.character || canvas.tokens?.controlled?.[0]?.actor;
    if (!actor) return ui.notifications.warn('Assign a character to your user (or select a token) before buying.');

    const cost = effectiveCp(entry, store);
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Buy from ${this.document.name}` },
      content: `<p><strong>${foundry.utils.escapeHTML(actor.name)}</strong> buys <strong>${foundry.utils.escapeHTML(entry.name)}</strong> for <strong>${cpLabel(cost)}</strong>?</p>`,
      rejectClose: false,
    }).catch(() => false);
    if (!ok) return;
    await requestTransaction({
      type:        'buy',
      journalUuid: this.document.uuid,
      entryUuid:   uuid,
      actorUuid:   actor.uuid,
    });
  }

  /** Add an item to the shelf. Compendium items are imported into the store's folder. */
  async _stockItem(itemOrEntry) {
    let item = itemOrEntry;
    if (item.pack || String(item.uuid || '').startsWith('Compendium.')) {
      const source = item.toObject ? item : await fromUuid(item.uuid);
      if (!source) return;
      const data = source.toObject();
      delete data._id;
      const store = this._getStoreClone();
      if (store.itemFolderId && game.folders.get(store.itemFolderId)) data.folder = store.itemFolderId;
      item = await Item.create(data);
      if (!item) return;
    }
    const snap = snapshotFromItem(item);
    await this._patch(s => {
      s.inventory = s.inventory || [];
      const existing = s.inventory.find(e => e.uuid === snap.uuid);
      if (existing) existing.qty = (Number(existing.qty) || 1) + 1;
      else s.inventory.push(snap);
    });
  }

  /* ── compendium browser actions ─────────────────────────── */

  _onToggleBrowser() {
    this.browserOpen = !this.browserOpen;
    this.render(false);
  }

  async _onAddFromBrowser(ev) {
    if (!this.isEditable) return;
    const uuid = ev.target.closest('[data-browser-uuid]')?.dataset?.browserUuid;
    if (!uuid) return;
    const source = await fromUuid(uuid).catch(() => null);
    if (!source) return;
    await this._stockItem(source);
    ui.notifications.info(`${source.name} added to ${this.document.name}.`);
  }

  /** Randomly stock 3 store-type-appropriate items from the compendium. */
  async _onRestock() {
    if (!this.isEditable) return;
    const store = this._getStoreClone();
    const index = await this._loadBrowserIndex();
    const cap = this._rarityCap(store);
    const rows = index
      .filter(e => matchesStoreType(e, store.storeType || 'general'))
      .filter(e => (RARITY_RANK[String(e.system?.rarity || '')] ?? 0) <= cap);
    if (!rows.length) return ui.notifications.warn('No matching compendium items found for this store type.');
    const owned = new Set((store.inventory || []).map(e => e.name));
    const pool = rows.filter(r => !owned.has(r.name));
    const picks = [];
    for (let i = 0; i < 3 && pool.length; i++) {
      picks.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    for (const pick of picks) {
      const source = await fromUuid(pick.uuid).catch(() => null);
      if (source) await this._stockItem(source);
    }
    if (picks.length) ui.notifications.info(`Restocked ${picks.length} item${picks.length === 1 ? '' : 's'}.`);
  }

  /* ── header editing ─────────────────────────────────────── */

  async _onEditField(ev) {
    if (!this.isEditable) return;
    const field = ev.target.closest('[data-field]')?.dataset?.field;
    if (!field) return;
    const store = this._getStoreClone();
    const current = field === 'name' ? (this.document.name || '')
                  : foundry.utils.getProperty(store, field) || '';
    const isLong = field === 'description' || field === 'owner.description';
    const input = isLong
      ? `<textarea name="value" rows="6" style="width:100%;">${foundry.utils.escapeHTML(String(current))}</textarea>`
      : `<input type="text" name="value" value="${foundry.utils.escapeHTML(String(current))}" style="width:100%;" />`;
    const value = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Edit ${field.split('.').pop()}` },
      content: input,
      ok: { label: 'Save', callback: (_ev, button) => button.form.elements.value.value },
      rejectClose: false,
    }).catch(() => null);
    if (value === null || value === undefined) return;
    if (field === 'name') {
      await this.document.update({ name: value });
      await this._patch(s => { s.name = value; });
    } else {
      await this._patch(s => foundry.utils.setProperty(s, field, value));
    }
  }

  _onEditOwner() {
    const store = this._getStoreClone();
    const o = store.owner || {};
    foundry.applications.api.DialogV2.prompt({
      window: { title: 'Shopkeeper' },
      content: `
        <div class="form-group"><label>Name</label><input type="text" name="oname" value="${foundry.utils.escapeHTML(o.name || '')}" /></div>
        <div class="form-group"><label>Race</label><input type="text" name="orace" value="${foundry.utils.escapeHTML(o.race || '')}" /></div>
        <div class="form-group"><label>Description</label><textarea name="odesc" rows="4">${foundry.utils.escapeHTML(o.description || '')}</textarea></div>`,
      ok: {
        label: 'Save',
        callback: (_ev, button) => ({
          name:        button.form.elements.oname.value,
          race:        button.form.elements.orace.value,
          description: button.form.elements.odesc.value,
        }),
      },
      rejectClose: false,
    }).then(owner => {
      if (owner && this.isEditable) this._patch(s => { s.owner = { ...(this._getStoreClone().owner || {}), ...owner } });
    }).catch(() => {});
  }

  /* ── economy controls ───────────────────────────────────── */

  async _onEditPrice(ev) {
    if (!this.isEditable) return;
    const uuid = ev.target.closest('[data-uuid]')?.dataset?.uuid;
    if (!uuid) return;
    const store = this._getStoreClone();
    const entry = (store.inventory || []).find(e => e.uuid === uuid);
    if (!entry) return;
    const currentGp = (Number(entry.priceCp) || 0) / 100;
    const value = await foundry.applications.api.DialogV2.prompt({
      window: { title: `Price: ${entry.name}` },
      content: `<div class="form-group"><label>Base price (gp)</label><input type="number" name="value" min="0" step="0.01" value="${currentGp}" /></div>`,
      ok: { label: 'Save', callback: (_ev, button) => button.form.elements.value.value },
      rejectClose: false,
    }).catch(() => null);
    if (value === null || value === undefined || value === '') return;
    const cp = Math.max(0, Math.round(Number(value) * 100));
    await this._patch(s => {
      const e = (s.inventory || []).find(x => x.uuid === uuid);
      if (e) { e.priceCp = cp; e.price = cpLabel(cp); }
    });
  }

  async _onStoreSettings() {
    if (!this.isEditable) return;
    const store = this._getStoreClone();
    const mul  = Number(store.priceMultiplier) || 1;
    const rate = Number.isFinite(Number(store.sellRate)) ? Number(store.sellRate) : 0.5;
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: `${this.document.name} — Store Settings` },
      content: `
        <div class="form-group"><label>Price multiplier</label>
          <input type="number" name="mul" min="0.1" max="5" step="0.05" value="${mul}" />
          <p class="hint">Applied to every listed price (haggling, festivals, sieges…).</p></div>
        <div class="form-group"><label>Buy-from-players rate</label>
          <input type="number" name="rate" min="0" max="1" step="0.05" value="${rate}" />
          <p class="hint">Fraction of item value paid when players sell (0.5 = half price).</p></div>
        <div class="form-group"><label>Special-order fee (%)</label>
          <input type="number" name="fee" min="0" max="100" step="1" value="${orderFeePct(store)}" />
          <p class="hint">Surcharge for ordering items the store does not stock.</p></div>
        <div class="form-group"><label class="checkbox"><input type="checkbox" name="selling" ${store.allowSelling !== false ? 'checked' : ''}/> Buys items from players</label></div>
        <div class="form-group"><label class="checkbox"><input type="checkbox" name="closed" ${store.closed ? 'checked' : ''}/> Store is closed</label></div>`,
      ok: {
        label: 'Save',
        callback: (_ev, button) => ({
          mul:     Number(button.form.elements.mul.value),
          rate:    Number(button.form.elements.rate.value),
          fee:     Number(button.form.elements.fee.value),
          selling: button.form.elements.selling.checked,
          closed:  button.form.elements.closed.checked,
        }),
      },
      rejectClose: false,
    }).catch(() => null);
    if (!result) return;
    await this._patch(s => {
      s.priceMultiplier = Number.isFinite(result.mul) && result.mul > 0 ? result.mul : 1;
      s.sellRate        = Number.isFinite(result.rate) ? Math.min(1, Math.max(0, result.rate)) : 0.5;
      s.orderFeePct     = Number.isFinite(result.fee) ? Math.min(100, Math.max(0, result.fee)) : 10;
      s.allowSelling    = result.selling;
      s.closed          = result.closed;
    });
  }

  async _onShareStore() {
    if (!this.isEditable) return;
    const levels = CONST.DOCUMENT_OWNERSHIP_LEVELS;
    await this.document.update({ 'ownership.default': levels.OBSERVER });
    await ChatMessage.create({
      content: `<p><i class="fa-solid fa-shop"></i> The party discovers @UUID[${this.document.uuid}]{${foundry.utils.escapeHTML(this.document.name)}} — come in and browse!</p>`,
    });
    ui.notifications.info(`${this.document.name} shared with players.`);
  }

  /* ── shopkeeper actor link ──────────────────────────────── */

  async _onDropOwnerActor(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    if (!this.isEditable) return;
    let data;
    try { data = JSON.parse(ev.dataTransfer.getData('text/plain')); } catch { return; }
    if (data.type !== 'Actor' || !data.uuid) return;
    const actor = await fromUuid(data.uuid).catch(() => null);
    if (!actor) return;
    await this._patch(s => {
      s.owner = s.owner || {};
      s.owner.name    = actor.name;
      s.owner.actorId = actor.id;
    });
    ui.notifications.info(`${actor.name} now runs ${this.document.name}.`);
  }

  _onOpenOwnerActor(ev) {
    ev?.stopPropagation?.();
    const store = this._getStoreClone();
    const actor = store.owner?.actorId ? game.actors.get(store.owner.actorId) : null;
    if (actor?.sheet) actor.sheet.render(true);
  }


  /* ── staff management ───────────────────────────────────── */

  _staffIdFromEvent(ev) {
    return ev.target.closest('[data-staff-id]')?.dataset?.staffId || null;
  }

  async _onEditStaff(staffId) {
    if (!this.isEditable) return;
    const store = this._getStoreClone();
    const member = staffId ? (store.staff || []).find(s => s.id === staffId) : {};
    if (staffId && !member) return;
    const result = await foundry.applications.api.DialogV2.prompt({
      window: { title: staffId ? `Edit ${member.name}` : 'Add staff member' },
      content: `
        <div class="form-group"><label>Name</label><input type="text" name="sname" value="${foundry.utils.escapeHTML(member?.name || '')}" /></div>
        <div class="form-group"><label>Role</label><input type="text" name="srole" value="${foundry.utils.escapeHTML(member?.role || '')}" placeholder="Clerk, guard, apprentice…" /></div>
        <div class="form-group"><label>Race</label><input type="text" name="skin" value="${foundry.utils.escapeHTML(member?.race || '')}" /></div>
        <div class="form-group"><label>Description</label><textarea name="sdesc" rows="3">${foundry.utils.escapeHTML(member?.description || '')}</textarea></div>`,
      ok: {
        label: 'Save',
        callback: (_ev, button) => ({
          name:        button.form.elements.sname.value.trim(),
          role:        button.form.elements.srole.value.trim(),
          kin:         button.form.elements.skin.value.trim(),
          description: button.form.elements.sdesc.value.trim(),
        }),
      },
      rejectClose: false,
    }).catch(() => null);
    if (!result || !result.name) return;
    await this._patch(s => {
      s.staff = s.staff || [];
      if (staffId) {
        const m = s.staff.find(x => x.id === staffId);
        if (m) { m.name = result.name; m.role = result.role; m.race = result.kin; m.description = result.description; }
      } else {
        s.staff.push({ id: foundry.utils.randomID(8), name: result.name, role: result.role || 'Clerk', race: result.kin, description: result.description, actorId: null });
      }
    });
  }

  async _onRemoveStaff(ev) {
    if (!this.isEditable) return;
    const staffId = this._staffIdFromEvent(ev);
    if (!staffId) return;
    await this._patch(s => { s.staff = (s.staff || []).filter(x => x.id !== staffId); });
  }

  /** Hand the staff member to the NPC Maker and link the created actor back. */
  _onGenerateStaffActor(ev) {
    if (!this.isEditable) return;
    if (!game.modules.get('DnD5eNpcMaker')?.active) {
      return ui.notifications.warn('Install & enable DnD5eNpcMaker to generate staff NPCs.');
    }
    const staffId = this._staffIdFromEvent(ev);
    const store = this._getStoreClone();
    const member = staffId === '__owner'
      ? { ...(store.owner || {}), role: 'Owner and shopkeeper' }
      : (store.staff || []).find(s => s.id === staffId);
    if (!member?.name) return;
    const description = [
      `${member.role || 'Employee'} at ${this.document.name}, a ${store.storeType || 'general'} store` +
        (store.settlementSize ? ` in a ${store.settlementSize}` : '') + '.',
      member.race ? `${member.race}.` : '',
      member.description || '',
    ].filter(Boolean).join(' ');
    const journalId = this.document.id;
    Hooks.callAll('DnD5eNpcMaker.openWithPrefill', {
      name: member.name,
      level: Math.max(1, Number(store.level) || 1),
      description,
      onCreate: async (actor) => {
        try {
          const journal = game.journal.get(journalId);
          if (!journal) return;
          const cur = foundry.utils.deepClone(journal.getFlag(MODULE_ID, FLAG_KEY)) || {};
          if (staffId === '__owner') {
            cur.owner = cur.owner || {};
            cur.owner.actorId = actor.id;
          } else {
            const m = (cur.staff || []).find(x => x.id === staffId);
            if (m) m.actorId = actor.id;
          }
          await journal.setFlag(MODULE_ID, FLAG_KEY, cur);
          ui.notifications.info(`${actor.name} linked to ${journal.name}.`);
        } catch (err) {
          console.error(`[${MODULE_ID}] failed to link staff actor`, err);
        }
      },
    });
  }

  _onOpenStaffActor(ev) {
    ev?.stopPropagation?.();
    const staffId = this._staffIdFromEvent(ev);
    const store = this._getStoreClone();
    const actorId = staffId === '__owner' ? store.owner?.actorId : (store.staff || []).find(s => s.id === staffId)?.actorId;
    const actor = actorId ? game.actors.get(actorId) : null;
    if (actor?.sheet) actor.sheet.render(true);
  }

  /* ── special orders ─────────────────────────────────────── */

  async _onOrderItem(ev) {
    const row = ev.target.closest('[data-browser-uuid]');
    if (!row) return;
    const uuid = row.dataset.browserUuid;
    const store = this._getStoreClone();
    if (store.closed && !this.isEditable) return ui.notifications.warn(`${this.document.name} is closed.`);

    const actor = game.user.character || canvas.tokens?.controlled?.[0]?.actor;
    if (!actor) return ui.notifications.warn('Assign a character to your user (or select a token) before ordering.');

    const baseCp = Number(row.dataset.priceCp) || 0;
    const mul = Number(store.priceMultiplier) || 1;
    const cost = Math.max(0, Math.round(baseCp * mul * (1 + orderFeePct(store) / 100)));
    const name = row.dataset.itemName || 'this item';
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: `Special order — ${this.document.name}` },
      content: `<p><strong>${foundry.utils.escapeHTML(actor.name)}</strong> orders <strong>${foundry.utils.escapeHTML(name)}</strong> for <strong>${cpLabel(cost)}</strong> (includes ${orderFeePct(store)}% ordering fee, paid in advance)?</p><p class="hint">The shopkeeper will send word when it arrives.</p>`,
      rejectClose: false,
    }).catch(() => false);
    if (!ok) return;
    await requestTransaction({
      type:        'order',
      journalUuid: this.document.uuid,
      itemUuid:    uuid,
      actorUuid:   actor.uuid,
    });
  }

  async _onDeliverOrder(ev) {
    if (!this.isEditable) return;
    const orderId = ev.target.closest('[data-order-id]')?.dataset?.orderId;
    if (!orderId) return;
    await requestTransaction({ type: 'deliverOrder', journalUuid: this.document.uuid, orderId });
  }

  async _onCancelOrder(ev) {
    if (!this.isEditable) return;
    const orderId = ev.target.closest('[data-order-id]')?.dataset?.orderId;
    if (!orderId) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: 'Cancel order' },
      content: '<p>Cancel this order and refund the buyer?</p>',
      rejectClose: false,
    }).catch(() => false);
    if (ok) await requestTransaction({ type: 'cancelOrder', journalUuid: this.document.uuid, orderId });
  }

  /* ── wiki fetch: convert an item from the reference wiki ── */

  async _onFetchWiki() {
    if (!this.isEditable) return;
    const name = await this._promptWikiName();
    if (!name || !name.trim()) return;
    await this._fetchWikiItem(name.trim());
  }

  _onImportWikiRow(ev) {
    if (!this.isEditable) return ui.notifications.warn('Ask your GM to import wiki items.');
    const name = ev.target.closest('[data-item-name]')?.dataset?.itemName;
    if (name) this._fetchWikiItem(name);
  }

  async _promptWikiName() {
    return foundry.applications.api.DialogV2.prompt({
      window: { title: 'Fetch item from the wiki' },
      content: `<div class="form-group"><label>Item name</label><input type="text" name="value" placeholder="e.g. Sunlance" autofocus /></div>
        <p class="hint">Searches the reference wiki and converts the item for Foundry (1 use). The item is imported into this store for your world only.</p>`,
      ok: { label: 'Fetch', callback: (_ev, button) => button.form.elements.value.value },
      rejectClose: false,
    }).catch(() => null);
  }

  async _fetchWikiItem(name) {
    const key = new Storage(MODULE_ID).getKey();
    if (!key) return ui.notifications.warn('Sign in with Patreon in the Store Generator first.');

    ui.notifications.info(`Converting "${name}" from the wiki…`);
    try {
      const endpoint = devUrl(WIKI_ENDPOINT, isDevMode(MODULE_ID));
      const { response, responseText } = await postToN8n(endpoint, { name }, key);
      let data;
      try { data = JSON.parse(responseText); } catch { throw new Error('Invalid response from the converter.'); }
      if (!response.ok || data?.ok === false) throw new Error(data?.message || `Server returned ${response.status}`);
      const raw = data.foundryItem || data.item;
      if (!raw || typeof raw !== 'object') throw new Error('No item data returned.');
      sanitizeItemDataDnd5e(raw, null);
      const store = this._getStoreClone();
      if (store.itemFolderId && game.folders.get(store.itemFolderId)) raw.folder = store.itemFolderId;
      const item = await Item.create(raw);
      if (!item) throw new Error('Foundry rejected the converted item.');
      await this._stockItem(item);
      ui.notifications.info(`"${item.name}" fetched from the wiki and stocked.`);
    } catch (err) {
      ui.notifications.error(`Wiki fetch failed: ${err.message}`);
    }
  }

}

/**
 * Build a store flag for journals created before the custom sheet existed.
 * Handles two legacy generations: journals that carried only itemFolderId,
 * and journals with no module flags at all — those are recognized by their
 * generated "Store Overview" page and rebuilt from its HTML.
 */
export function migrateLegacyStore(journal) {
  const flags = journal?.flags?.[MODULE_ID] || {};
  if (flags[FLAG_KEY]) return null;

  const folderId = flags.itemFolderId || null;
  const folder = folderId ? game.folders.get(folderId) : null;
  let inventory = folder ? game.items.filter(i => i.folder?.id === folderId).map(snapshotFromItem) : [];

  const page = journal?.pages?.find?.(p => p.name === 'Store Overview');
  const html = page?.text?.content || '';
  const looksLikeStore = /<h2>\s*(Inventory|Shopkeeper)\s*<\/h2>/i.test(html);
  if (!folderId && !looksLikeStore) return null;

  let storeType = 'general';
  let settlementSize = 'town';
  let wealth = 'modest';
  let description = '';
  let owner = null;

  if (html) {
    const headMatch = html.match(/<p><strong>([^<]+)<\/strong>(?:\s*·\s*([^<]+))?<\/p>/);
    if (headMatch) {
      const label = headMatch[1].trim();
      for (const [key, l] of Object.entries(STORE_TYPE_LABELS)) if (l === label) storeType = key;
      const size = (headMatch[2] || '').trim().toLowerCase();
      if (['village', 'town', 'city', 'metropolis'].includes(size)) settlementSize = size;
    }
    const descMatch = html.match(/<p><strong>[^<]*<\/strong>[^<]*<\/p>\s*<p>([\s\S]*?)<\/p>/);
    if (descMatch) description = descMatch[1].replace(/<[^>]+>/g, '').trim();
    const ownerMatch = html.match(/<h2>\s*Shopkeeper\s*<\/h2>\s*<p><strong>([^<]+)<\/strong>(?:\s*[—-]\s*([^<]+))?<\/p>\s*(?:<p>([\s\S]*?)<\/p>)?/i);
    if (ownerMatch) {
      owner = {
        name:        ownerMatch[1].trim(),
        race:        (ownerMatch[2] || '').trim(),
        description: (ownerMatch[3] || '').replace(/<[^>]+>/g, '').trim(),
      };
    }
    if (!inventory.length) {
      const rowRe = /@UUID\[([^\]]+)\]\{([^}]*)\}<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>\s*<td[^>]*>\s*([^<]*?)\s*<\/td>/g;
      let m;
      while ((m = rowRe.exec(html))) {
        let doc = null;
        try { doc = fromUuidSync(m[1]); } catch (_) { /* compendium uuids need async — fall through */ }
        if (doc) inventory.push(snapshotFromItem(doc));
        else inventory.push({
          uuid:    m[1],
          name:    m[2] || 'Item',
          img:     'icons/svg/item-bag.svg',
          type:    'equipment',
          rarity:  m[3] || 'Mundane',
          price:   m[4] || '—',
          priceCp: parsePriceLabelCp(m[4] || ''),
          qty:     1,
        });
      }
    }
  }

  return {
    name:           journal.name,
    storeType,
    wealth,
    settlementSize,
    description,
    owner,
    staff:          [],
    itemFolderId:   folderId,
    inventory,
  };
}
