/**
 * D&D 5e Store SystemAdapter — generates a complete store (shopkeeper, flavour,
 * and a stocked inventory) from a short description.
 *
 * The inventory items land in the world's Items directory inside a folder
 * named after the store; a JournalEntry ties the whole store together.
 *
 * @typedef {object} Dnd5eStoreFormData
 * @property {string} name           Store name.
 * @property {string} storeType      One of the STORE_TYPE_LABELS keys.
 * @property {string} wealth         Stock wealth tier ('poor'|'modest'|'wealthy'|'aristocratic').
 * @property {string} settlementSize Settlement size hint for stock breadth.
 * @property {string} description    Free-text description for the AI.
 */

import { SystemAdapter, postToN8n, ActorCreationError } from './core/adapter.js';
import { N8N_BASE, devUrl }               from './core/n8n.js';
import { detectModuleFolder,
         escapeHtml }                     from './core/utils.js';
import { sanitizeItemDataDnd5e,
         tryFixItemValidationErrorDnd5e } from './sanitizer.js';

const MODULE_FOLDER  = detectModuleFolder('Dnd5eStoreGenerator');
const STORE_ENDPOINT = `${N8N_BASE}/webhook/dnd5e-store-builder`;

/** Monthly uses charged per store generation. */
export const STORE_COST = 7;

const STORE_TYPE_LABELS = {
  general:      'General Goods',
  blacksmith:   'Blacksmith / Weaponsmith',
  armorer:      'Armorer',
  alchemist:    'Alchemist / Apothecary',
  magic:        'Magic Shop',
  jeweler:      'Jeweler / Curiosities',
  fletcher:     'Fletcher / Bowyer',
  tavern:       'Tavern / Inn',
};

const WEALTH_LABELS = {
  poor:         'Poor',
  modest:       'Modest',
  wealthy:      'Wealthy',
  aristocratic: 'Aristocratic',
};

const SETTLEMENT_SIZE_LABELS = {
  village:    'Village',
  town:       'Town',
  city:       'City',
  metropolis: 'Metropolis',
};

export class Dnd5eStoreAdapter extends SystemAdapter {
  get moduleFolder() { return MODULE_FOLDER; }

  get module() {
    return {
      id:           'Dnd5eStoreGenerator',
      label:        'D&D Store',
      icon:         'fa-solid fa-shop',
      githubUrl:    'https://github.com/JamesCfer/Dnd5eStoreGenerator',
      historyLabel: 'Created Stores',
    };
  }

  get systemId() { return 'dnd5e'; }

  get formConfig() { return { documentNoun: 'store' }; }

  get progressSteps() {
    return ['Sending request…', 'Stocking the shelves…', 'Creating documents…'];
  }

  /* ── Form handling ──────────────────────────────────────── */

  /** @returns {Dnd5eStoreFormData} */
  gatherFormData(form) {
    const fd = new FormData(form);
    const name           = (fd.get('name')?.toString()?.trim()) || 'Generated Store';
    const storeType      = (fd.get('storeType')?.toString() || 'general').trim();
    const wealth         = (fd.get('wealth')?.toString() || 'modest').trim();
    const settlementSize = (fd.get('settlementSize')?.toString() || 'town').trim();
    const description    = (fd.get('description')?.toString()?.trim()) || '';

    if (!description) throw new Error('Please provide a description for the store.');
    return { name, storeType, wealth, settlementSize, description };
  }

  historyEntryFromForm(formData) {
    return {
      name:           formData.name,
      storeType:      formData.storeType,
      wealth:         formData.wealth,
      settlementSize: formData.settlementSize,
      description:    formData.description,
    };
  }

  historyMeta(entry) {
    const typeLabel   = STORE_TYPE_LABELS[entry.storeType] || 'Store';
    const wealthLabel = WEALTH_LABELS[entry.wealth] || 'Modest';
    return `${wealthLabel}&nbsp;·&nbsp;${typeLabel}`;
  }

  populateForm(form, entry) {
    const nameInput    = form.querySelector('[name="name"]');
    const typeSelect   = form.querySelector('[name="storeType"]');
    const wealthSelect = form.querySelector('[name="wealth"]');
    const sizeSelect   = form.querySelector('[name="settlementSize"]');
    const descTextarea = form.querySelector('[name="description"]');
    if (nameInput)    nameInput.value    = entry.name ?? '';
    if (typeSelect)   typeSelect.value   = entry.storeType ?? 'general';
    if (wealthSelect) wealthSelect.value = entry.wealth ?? 'modest';
    if (sizeSelect)   sizeSelect.value   = entry.settlementSize ?? 'town';
    if (descTextarea) descTextarea.value = entry.description ?? '';
  }

  /* ── Generation ─────────────────────────────────────────── */

  /**
   * @param {import('./core/adapter.js').GenerateOptions & { formData: Dnd5eStoreFormData }} opts
   * @returns {Promise<import('./core/adapter.js').AdapterResult>}
   */
  async generate({ formData, key, devMode }) {
    const endpoint = devUrl(STORE_ENDPOINT, devMode);
    const payload  = {
      name:           formData.name,
      storeType:      formData.storeType,
      wealth:         formData.wealth,
      settlementSize: formData.settlementSize,
      description:    formData.description,
    };

    const { response, responseText } = await postToN8n(endpoint, payload, key);

    let data;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      throw new Error(`Invalid JSON response (${responseText.length} bytes): ${err.message}`);
    }

    if (!response.ok) throw new Error(data?.message || `Server returned status ${response.status}`);
    if (data?.ok === false) throw new Error(data?.message || data?.error || 'Server rejected the request');

    const store = data.store || data.foundryStore || data;
    if (!store || typeof store !== 'object') throw new Error('No valid store data returned from server');

    const inventory = Array.isArray(store.inventory) ? store.inventory
                    : Array.isArray(store.items)     ? store.items
                    : Array.isArray(data.foundryItems) ? data.foundryItems
                    : [];

    const storeName = store.name || formData.name;

    // Inventory items go into a folder named after the store.
    let folder = null;
    try {
      folder = await Folder.create({ name: storeName, type: 'Item' });
    } catch (_) { /* folderless creation still works */ }

    const createdItems = [];
    for (const rawItem of inventory) {
      if (!rawItem || typeof rawItem !== 'object') continue;
      sanitizeItemDataDnd5e(rawItem, null, null);
      if (folder) rawItem.folder = folder.id;

      let item = null, attempts = 0;
      while (!item && attempts < 10) {
        attempts++;
        try {
          item = await Item.create(rawItem);
        } catch (error) {
          const errorText = error.toString ? error.toString() : String(error.message || error);
          if (tryFixItemValidationErrorDnd5e(rawItem, errorText)) continue;
          console.warn(`[${this.module.id}] Skipping rejected inventory item "${rawItem.name}": ${error.message}`);
          break;
        }
      }
      if (item) createdItems.push(item);
    }

    const journalData = {
      name: storeName,
      pages: [{
        name: 'Store Overview',
        type: 'text',
        text: { content: buildStoreJournalHtml(store, formData, createdItems), format: 1 },
      }],
    };
    // The store flag drives the custom store sheet (see store-sheet.js).
    journalData.flags = {
      [this.module.id]: {
        ...(folder?.id ? { itemFolderId: folder.id } : {}),
        store: {
          name:           storeName,
          storeType:      store.storeType || formData.storeType,
          wealth:         store.wealth || formData.wealth,
          settlementSize: store.settlementSize || formData.settlementSize,
          description:    store.description || formData.description,
          owner:          store.owner || store.shopkeeper || null,
          staff:          (Array.isArray(store.staff) ? store.staff : []).map(s => ({
            id:          foundry.utils.randomID(8),
            name:        s.name || 'Employee',
            race:    s.race || '',
            role:        s.role || 'Clerk',
            description: s.description || '',
            actorId:     null,
          })),
          itemFolderId:   folder?.id || null,
          inventory:      createdItems.map(item => {
            const data = item.toObject ? item.toObject() : item;
            return {
              uuid:   item.uuid,
              name:   item.name,
              img:    item.img || 'icons/svg/item-bag.svg',
              type:   item.type,
              rarity: rarityLabel(data),
              price:  priceLabel(data),
              priceCp: Math.round((Number(data.system?.price?.value) || 0) * ({ pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 }[data.system?.price?.denomination] || 100)),
              qty:    Math.max(1, Number(data.system?.quantity) || 1),
            };
          }),
        },
      },
    };

    let journal;
    try {
      journal = await JournalEntry.create(journalData);
    } catch (error) {
      throw new ActorCreationError(`Foundry rejected the store journal: ${error.message}`, store);
    }
    if (!journal) throw new ActorCreationError('Store journal creation returned null', store);

    return {
      document:   journal,
      exportData: {
        content:  JSON.stringify(store, null, 2),
        filename: `${storeName || 'store'}.json`,
        mimeType: 'application/json',
      },
      message: `Store "${storeName}" created with ${createdItems.length} item${createdItems.length === 1 ? '' : 's'} in stock!`,
    };
  }
}

/* ── Journal rendering helpers ───────────────────────────── */

/** Human-readable price for a D&D 5e item's data, or the entry's own price string. */
function priceLabel(itemData) {
  if (typeof itemData?.price === 'string' && itemData.price) return itemData.price;
  const p = itemData?.system?.price;
  if (p && typeof p === 'object' && Number(p.value)) {
    return `${Number(p.value)} ${p.denomination || 'gp'}`;
  }
  if (typeof p === 'number' && p) return `${p} gp`;
  return '—';
}

function rarityLabel(itemData) {
  const labels = {
    common: 'Common', uncommon: 'Uncommon', rare: 'Rare',
    veryRare: 'Very Rare', legendary: 'Legendary', artifact: 'Artifact',
  };
  return labels[itemData?.system?.rarity] || 'Mundane';
}

function buildStoreJournalHtml(store, formData, createdItems) {
  const typeLabel   = STORE_TYPE_LABELS[store.storeType || formData.storeType] || 'Store';
  const wealthLabel = WEALTH_LABELS[store.wealth || formData.wealth] || '';
  const sizeLabel   = SETTLEMENT_SIZE_LABELS[store.settlementSize || formData.settlementSize] || '';
  const owner       = store.owner || store.shopkeeper || null;

  const descHtml = store.description
    ? `<p>${escapeHtml(store.description)}</p>`
    : `<p>${escapeHtml(formData.description)}</p>`;

  const ownerHtml = owner
    ? `<h2>Shopkeeper</h2>
       <p><strong>${escapeHtml(owner.name || 'Unnamed shopkeeper')}</strong>${owner.race || owner.ancestry ? ` — ${escapeHtml(owner.race || owner.ancestry)}` : ''}</p>
       ${owner.description ? `<p>${escapeHtml(owner.description)}</p>` : ''}`
    : '';

  const rows = createdItems.map(item => {
    const data = item.toObject ? item.toObject() : item;
    return `<tr>
      <td>@UUID[${item.uuid}]{${escapeHtml(item.name)}}</td>
      <td style="text-align:center;">${escapeHtml(rarityLabel(data))}</td>
      <td style="text-align:right;">${escapeHtml(priceLabel(data))}</td>
    </tr>`;
  }).join('');

  const inventoryHtml = rows
    ? `<h2>Inventory</h2>
       <table>
         <thead><tr><th>Item</th><th>Rarity</th><th>Price</th></tr></thead>
         <tbody>${rows}</tbody>
       </table>`
    : '<h2>Inventory</h2><p><em>No inventory items were created.</em></p>';

  const metaBits = [typeLabel, wealthLabel, sizeLabel].filter(Boolean).map(escapeHtml).join(' · ');

  return `
    <p><strong>${metaBits}</strong></p>
    ${descHtml}
    ${ownerHtml}
    ${inventoryHtml}`.trim();
}
