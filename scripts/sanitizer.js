/**
 * D&D 5e — Item data sanitization.
 *
 * Ensures a valid _id, the type maps to a recognised dnd5e item type,
 * and required system fields are present. The n8n dnd5e-item-builder is
 * expected to produce mostly-valid data; this is a safety net.
 */

const VALID_ITEM_TYPES = new Set([
  'weapon', 'equipment', 'consumable', 'tool', 'loot', 'container',
]);

// Empty string is valid (mundane item with no rarity).
const VALID_RARITIES = new Set([
  '', 'common', 'uncommon', 'rare', 'veryRare', 'legendary', 'artifact',
]);

export function sanitizeItemDataDnd5e(itemData, requestedType, requestedRarity) {
  const generateId = () => foundry.utils.randomID(16);

  if (!itemData._id || itemData._id.length !== 16 || !/^[a-zA-Z0-9]{16}$/.test(itemData._id)) {
    itemData._id = generateId();
  }

  // Coerce type: prefer server-provided, fall back to user request, then 'loot'.
  if (!VALID_ITEM_TYPES.has(itemData.type)) {
    if (requestedType && VALID_ITEM_TYPES.has(requestedType)) {
      itemData.type = requestedType;
    } else {
      itemData.type = 'loot';
    }
  }

  if (!itemData.name) itemData.name = 'Unnamed Item';
  if (!itemData.img)  itemData.img  = 'icons/svg/item-bag.svg';
  if (!itemData.flags) itemData.flags = {};

  if (!itemData.system) itemData.system = {};
  const s = itemData.system;

  // Description
  if (!s.description || typeof s.description !== 'object') {
    s.description = { value: '', chat: '', unidentified: '' };
  }
  if (typeof s.description.value !== 'string') s.description.value = '';
  if (typeof s.description.chat !== 'string')  s.description.chat  = '';

  // Rarity — '' is valid (mundane). Fall back to user's requested value, then ''.
  if (!VALID_RARITIES.has(s.rarity)) {
    s.rarity = VALID_RARITIES.has(requestedRarity) ? requestedRarity : '';
  }

  // Attunement — server sets this; just ensure it's a valid dnd5e number (0/1/2).
  if (typeof s.attunement !== 'number' || ![0, 1, 2].includes(s.attunement)) {
    s.attunement = 0;
  }

  // Quantity / weight / price
  if (typeof s.quantity !== 'number') s.quantity = 1;
  if (typeof s.weight   !== 'number') s.weight   = 0;
  if (!s.price || typeof s.price !== 'object') s.price = { value: 0, denomination: 'gp' };
  if (!s.price.denomination) s.price.denomination = 'gp';

  // Identification
  if (typeof s.identified !== 'boolean') s.identified = true;
  if (typeof s.equipped   !== 'boolean') s.equipped   = false;

  // Weapon-specific defaults
  if (itemData.type === 'weapon') {
    if (!s.damage || typeof s.damage !== 'object') {
      s.damage = { parts: [], versatile: '' };
    }
    if (!Array.isArray(s.damage.parts)) s.damage.parts = [];
    if (!s.properties || typeof s.properties !== 'object') s.properties = {};
  }

  // Consumable-specific defaults
  if (itemData.type === 'consumable') {
    if (!s.consumableType) s.consumableType = 'trinket';
    if (!s.uses || typeof s.uses !== 'object') {
      s.uses = { value: 1, max: '1', per: 'charges', autoDestroy: true };
    }
  }

  // Container-specific defaults
  if (itemData.type === 'container') {
    if (!s.capacity || typeof s.capacity !== 'object') {
      s.capacity = { type: 'weight', value: 500, weightless: false };
    }
  }

  return itemData;
}

export function tryFixItemValidationErrorDnd5e(itemData, errorMessage) {
  const invalidTypeMatch = errorMessage.match(/"(\w+)" is not a valid type/);
  if (invalidTypeMatch && itemData.type === invalidTypeMatch[1]) {
    itemData.type = 'loot';
    return true;
  }

  // Strip unrecognised weapon properties
  const invalidPropMatch = errorMessage.match(/(\w+) is not a valid choice/);
  if (invalidPropMatch && itemData.type === 'weapon' && itemData.system?.properties) {
    const badProp = invalidPropMatch[1];
    if (badProp in itemData.system.properties) {
      delete itemData.system.properties[badProp];
      return true;
    }
  }

  return false;
}
