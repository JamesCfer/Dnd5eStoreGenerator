/**
 * Store transactions (D&D 5e) — buy/sell with real currency movement.
 *
 * Players cannot edit the store journal, so purchases are relayed over a
 * module socket to the active GM's client, which validates funds and stock,
 * moves coins and items, updates the store flag, and posts a receipt.
 * When the acting user IS a GM the transaction executes locally.
 */

const MODULE_ID = 'Dnd5eStoreGenerator';
const FLAG_KEY  = 'store';
const SOCKET    = `module.${MODULE_ID}`;

const DENOM_CP = { pp: 1000, gp: 100, ep: 50, sp: 10, cp: 1 };

/* ── currency helpers (dnd5e currency object) ─────────────── */

export function priceToCp(price) {
  if (!price || typeof price !== 'object') return (Number(price) || 0) * 100;
  return Math.round((Number(price.value) || 0) * (DENOM_CP[price.denomination] || 100));
}

export function cpLabel(cp) {
  cp = Math.max(0, Math.round(cp));
  const gp = Math.floor(cp / 100);
  const sp = Math.floor((cp % 100) / 10);
  const c  = cp % 10;
  const parts = [];
  if (gp) parts.push(`${gp} gp`);
  if (sp) parts.push(`${sp} sp`);
  if (c)  parts.push(`${c} cp`);
  return parts.length ? parts.join(', ') : 'free';
}

/** Parse a price label like "25 gp" back into copper (legacy snapshots). */
export function parsePriceLabelCp(label) {
  if (!label || label === '—') return 0;
  let cp = 0;
  const re = /(\d+(?:\.\d+)?)\s*(pp|gp|ep|sp|cp)/gi;
  let m;
  while ((m = re.exec(String(label)))) cp += Number(m[1]) * DENOM_CP[m[2].toLowerCase()];
  return Math.round(cp);
}

/** Effective sale price in copper, after the store's price multiplier. */
export function effectiveCp(entry, store) {
  const baseCp = Number(entry.priceCp) || parsePriceLabelCp(entry.price);
  const mul = Number(store.priceMultiplier) || 1;
  return Math.max(0, Math.round(baseCp * mul));
}

function actorTotalCp(actor) {
  const c = actor.system?.currency || {};
  return Object.entries(DENOM_CP).reduce((sum, [d, mul]) => sum + (Number(c[d]) || 0) * mul, 0);
}

/**
 * Rewrites the actor's coin purse to a new total. Change is made in
 * gp/sp/cp; existing pp is kept when it doesn't need breaking.
 */
async function setActorCp(actor, targetCp) {
  const cur = actor.system?.currency || {};
  const currency = { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  let remaining = targetCp;
  const keepPp = Math.min(Number(cur.pp) || 0, Math.floor(remaining / 1000));
  currency.pp = keepPp;
  remaining -= keepPp * 1000;
  currency.gp = Math.floor(remaining / 100);
  currency.sp = Math.floor((remaining % 100) / 10);
  currency.cp = remaining % 10;
  await actor.update({ 'system.currency': currency });
}

async function deductCoins(actor, cp) {
  const total = actorTotalCp(actor);
  if (total < cp) return false;
  await setActorCp(actor, total - cp);
  return true;
}

async function addCoins(actor, cp) {
  await setActorCp(actor, actorTotalCp(actor) + cp);
}

/* ── transaction execution (runs on a GM client) ──────────── */

function getStoreFlag(journal) { return journal?.getFlag?.(MODULE_ID, FLAG_KEY) || null; }

async function postReceipt(kind, { actor, itemName, storeName, cp }) {
  const verb = kind === 'buy' ? 'bought' : 'sold';
  const prep = kind === 'buy' ? 'from' : 'to';
  await ChatMessage.create({
    content: `<p class="cfer-store-receipt"><i class="fa-solid fa-coins"></i> <strong>${foundry.utils.escapeHTML(actor.name)}</strong> ${verb} <strong>${foundry.utils.escapeHTML(itemName)}</strong> ${prep} <strong>${foundry.utils.escapeHTML(storeName)}</strong> for <strong>${cpLabel(cp)}</strong>.</p>`,
  });
}

export async function executeBuy({ journalUuid, entryUuid, actorUuid }) {
  const journal = await fromUuid(journalUuid);
  const store = getStoreFlag(journal);
  if (!store) return { ok: false, message: 'Store not found.' };
  if (store.closed) return { ok: false, message: `${journal.name} is closed.` };

  const entry = (store.inventory || []).find(e => e.uuid === entryUuid);
  if (!entry || (Number(entry.qty) || 0) < 1) return { ok: false, message: 'That item is out of stock.' };

  const actor = await fromUuid(actorUuid);
  if (!actor) return { ok: false, message: 'Buyer actor not found.' };

  const cost = effectiveCp(entry, store);
  if (!(await deductCoins(actor, cost))) {
    return { ok: false, message: `${actor.name} cannot afford ${entry.name} (${cpLabel(cost)}).` };
  }

  const worldItem = await fromUuid(entry.uuid).catch(() => null);
  if (!worldItem) {
    await addCoins(actor, cost);
    return { ok: false, message: 'The stocked item no longer exists — purchase refunded.' };
  }

  const data = worldItem.toObject();
  delete data._id;
  delete data.folder;
  data.system = data.system || {};
  data.system.quantity = 1;
  await actor.createEmbeddedDocuments('Item', [data]);

  const inventory = foundry.utils.deepClone(store.inventory);
  const flagEntry = inventory.find(e => e.uuid === entryUuid);
  flagEntry.qty = (Number(flagEntry.qty) || 1) - 1;
  const next = flagEntry.qty < 1 ? inventory.filter(e => e.uuid !== entryUuid) : inventory;
  await journal.setFlag(MODULE_ID, FLAG_KEY, { ...store, inventory: next });

  await postReceipt('buy', { actor, itemName: entry.name, storeName: journal.name, cp: cost });
  return { ok: true, message: `Bought ${entry.name} for ${cpLabel(cost)}.` };
}

export async function executeSell({ journalUuid, itemUuid, actorUuid }) {
  const journal = await fromUuid(journalUuid);
  const store = getStoreFlag(journal);
  if (!store) return { ok: false, message: 'Store not found.' };
  if (store.closed) return { ok: false, message: `${journal.name} is closed.` };
  if (store.allowSelling === false) return { ok: false, message: `${journal.name} is not buying from adventurers.` };

  const item = await fromUuid(itemUuid);
  const actor = await fromUuid(actorUuid);
  if (!item || !actor) return { ok: false, message: 'Item or actor not found.' };

  const baseCp = priceToCp(item.system?.price);
  const rate = Number.isFinite(Number(store.sellRate)) ? Number(store.sellRate) : 0.5;
  const payout = Math.max(0, Math.round(baseCp * rate));

  // Move one unit into the store's folder as a world item.
  const data = item.toObject();
  delete data._id;
  data.system = data.system || {};
  data.system.quantity = 1;
  if (store.itemFolderId && game.folders.get(store.itemFolderId)) data.folder = store.itemFolderId;
  const worldItem = await Item.create(data);

  const qty = Number(item.system?.quantity) || 1;
  if (qty > 1) await item.update({ 'system.quantity': qty - 1 });
  else await item.delete();

  await addCoins(actor, payout);

  const RARITY_LABELS = { common: 'Common', uncommon: 'Uncommon', rare: 'Rare', veryRare: 'Very Rare', legendary: 'Legendary', artifact: 'Artifact' };
  const inventory = foundry.utils.deepClone(store.inventory || []);
  inventory.push({
    uuid:    worldItem.uuid,
    name:    worldItem.name,
    img:     worldItem.img || 'icons/svg/item-bag.svg',
    type:    worldItem.type,
    rarity:  RARITY_LABELS[worldItem.system?.rarity] || 'Mundane',
    price:   cpLabel(baseCp),
    priceCp: baseCp,
    qty:     1,
  });
  await journal.setFlag(MODULE_ID, FLAG_KEY, { ...store, inventory });

  await postReceipt('sell', { actor, itemName: worldItem.name, storeName: journal.name, cp: payout });
  return { ok: true, message: `Sold ${worldItem.name} for ${cpLabel(payout)}.` };
}

/* ── socket relay ─────────────────────────────────────────── */

async function handleSocket(data) {
  if (data?.type === 'result') {
    if (data.userId === game.user.id) ui.notifications[data.ok ? 'info' : 'warn'](data.message);
    return;
  }
  // Only the designated active GM executes transactions.
  if (!game.users.activeGM?.isSelf) return;
  let result;
  if (data?.type === 'buy')      result = await executeBuy(data);
  else if (data?.type === 'sell') result = await executeSell(data);
  else return;
  game.socket.emit(SOCKET, { type: 'result', userId: data.userId, ...result });
}

export function registerStoreSockets() {
  game.socket.on(SOCKET, data => { handleSocket(data).catch(err => console.error(`[${MODULE_ID}] socket transaction failed`, err)); });
}

/** Run a transaction: locally when GM, otherwise relayed to the active GM. */
export async function requestTransaction(payload) {
  if (game.user.isGM) {
    const result = payload.type === 'buy' ? await executeBuy(payload) : await executeSell(payload);
    ui.notifications[result.ok ? 'info' : 'warn'](result.message);
    return result;
  }
  if (!game.users.activeGM) {
    ui.notifications.warn('A GM must be online to trade with stores.');
    return { ok: false, message: 'No GM online.' };
  }
  game.socket.emit(SOCKET, { ...payload, userId: game.user.id });
  return { ok: true, message: 'Request sent to the GM.' };
}
