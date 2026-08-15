/**
 * Shared utility helpers used by every module.
 */

const _THEMED_NAMES = {
  dark:    ['Malachar', 'Vethrak', 'Draven', 'Sablekin', 'Kaelnoc', 'Ravenshaw', 'Grimoth', 'Noctivus'],
  fire:    ['Embyr', 'Pyrath', 'Scorran', 'Cinadrel', 'Ignath', 'Torrek', 'Zarinn', 'Brandan'],
  holy:    ['Aeryndel', 'Seraphel', 'Valorian', 'Luxara', 'Halith', 'Auriel', 'Dawnel', 'Caleth'],
  undead:  ['Mortivus', 'Hektash', 'Ashgarren', 'Pallor', 'Vekrath', 'Nekroth', 'Ulgrave', 'Bonethane'],
  arcane:  ['Arcanel', 'Noxivus', 'Runeval', 'Velith', 'Zarael', 'Mystrox', 'Hexari', 'Aethos'],
  nature:  ['Tharnil', 'Sylvara', 'Briarmoss', 'Fernil', 'Grovekin', 'Bramwen', 'Sylkith', 'Mosshan'],
  combat:  ['Dravan', 'Keldrak', 'Ralmar', 'Vornath', 'Brakken', 'Thornvel', 'Grimfist', 'Haldrek'],
  default: ['Tavelin', 'Rennick', 'Kirath', 'Arenvald', 'Selenor', 'Darenmos', 'Vaelith', 'Corvan'],
};

const _THEME_KEYWORDS = {
  dark:    ['dark', 'shadow', 'evil', 'corrupt', 'sinister', 'villain', 'fell', 'cruel', 'malevolent'],
  fire:    ['fire', 'flame', 'burn', 'pyro', 'ember', 'inferno', 'scorch', 'blaze', 'lava'],
  holy:    ['holy', 'divine', 'paladin', 'cleric', 'celestial', 'sacred', 'blessed', 'angel'],
  undead:  ['undead', 'necro', 'zombie', 'skeleton', 'lich', 'vampire', 'ghost', 'death', 'ghoul'],
  arcane:  ['magic', 'arcane', 'wizard', 'spell', 'sorcerer', 'mage', 'enchant', 'rune', 'mystic'],
  nature:  ['druid', 'nature', 'forest', 'ranger', 'beast', 'animal', 'wild', 'plant', 'earth'],
  combat:  ['warrior', 'fighter', 'barbarian', 'battle', 'soldier', 'guard', 'mercen', 'berserker'],
};

/** Compare two semver strings — returns true if `a` is strictly newer than `b`. */
export function isNewerVersion(a, b) {
  const parse = v => (v || '0.0.0').split('.').map(n => parseInt(n, 10) || 0);
  const [a1, a2, a3] = parse(a);
  const [b1, b2, b3] = parse(b);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
}

/** Escape an arbitrary string for safe insertion into HTML. */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str);
  return div.innerHTML;
}

/**
 * Returns a short thematic name drawn from curated lists, keyed to keywords
 * found in the description string.  Falls back to a neutral fantasy name when
 * no keywords match.
 * @param {string} description
 * @returns {string}
 */
export function generateThematicName(description) {
  const lower = (description || '').toLowerCase();
  let theme = 'default';
  for (const [t, words] of Object.entries(_THEME_KEYWORDS)) {
    if (words.some(w => lower.includes(w))) { theme = t; break; }
  }
  const list = _THEMED_NAMES[theme] ?? _THEMED_NAMES.default;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * The folder name this module is installed under, derived from the script's URL.
 * Independent of module id — works regardless of legacy install paths.
 */
export function detectModuleFolder(fallbackId) {
  const match = (import.meta?.url ?? '').match(/\/modules\/([^/]+)\//);
  if (match) return match[1];
  return fallbackId || 'unknown-module';
}
