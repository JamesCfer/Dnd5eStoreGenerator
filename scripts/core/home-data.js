/**
 * Metadata for every module in the family.
 * The home page renders one card per entry — the card matching the running
 * module is highlighted as "this module"; the others link to their GitHub
 * release pages so users can install them too.
 */

/**
 * @typedef {object} ModuleMetadata
 * @property {string} id           Foundry module id.
 * @property {string} system       Foundry game system id ('pf2e', 'dnd5e', 'hero6e').
 * @property {string} label        Short display name for the home card.
 * @property {string} icon         FontAwesome class string.
 * @property {string} accentClass  CSS class applied to the home card for system colour.
 * @property {string} description  One-sentence summary shown on the home card.
 * @property {string} github       Repository URL.
 * @property {string} install      Latest-release URL used as the install link.
 */

/** @type {ModuleMetadata[]} */
export const ALL_MODULES = [
  {
    id:          'Pf2eNpcMaker',
    system:      'pf2e',
    label:       'Pathfinder 2e NPC',
    icon:        'fa-solid fa-dragon',
    accentClass: 'card--pf2e',
    description: 'Generate fully-statted PF2e NPCs from a description.',
    github:      'https://github.com/JamesCfer/Pf2eNpcMaker',
    install:     'https://github.com/JamesCfer/Pf2eNpcMaker/releases/latest',
  },
  {
    id:          'DnD5eNpcMaker',
    system:      'dnd5e',
    label:       'D&D 5e NPC',
    icon:        'fa-solid fa-shield-halved',
    accentClass: 'card--dnd5e',
    description: 'Generate D&D 5e creatures with stat blocks, spells, and CR.',
    github:      'https://github.com/JamesCfer/DnD5eNpcMaker',
    install:     'https://github.com/JamesCfer/DnD5eNpcMaker/releases/latest',
  },
  {
    id:          'Hero6eNpcMaker',
    system:      'hero6e',
    label:       'HERO System 6e',
    icon:        'fa-solid fa-bolt',
    accentClass: 'card--hero6e',
    description: 'Generate Hero System 6e characters and import the .hdc directly.',
    github:      'https://github.com/JamesCfer/Hero6eNpcMaker',
    install:     'https://github.com/JamesCfer/Hero6eNpcMaker/releases/latest',
  },
  {
    id:          'Pf2eItemGenerator',
    system:      'pf2e',
    label:       'Pathfinder 2e Item',
    icon:        'fa-solid fa-flask',
    accentClass: 'card--pf2eitem',
    description: 'Generate PF2e items (weapons, armor, consumables, treasure) from a description.',
    github:      'https://github.com/JamesCfer/Pf2eItemMaker',
    install:     'https://github.com/JamesCfer/Pf2eItemMaker/releases/latest',
  },
  {
    id:          'Dnd5eItemGenerator',
    system:      'dnd5e',
    label:       'D&D 5e Item',
    icon:        'fa-solid fa-hat-wizard',
    accentClass: 'card--dnd5eitem',
    description: 'Generate D&D 5e magic items (weapons, armor, wondrous items, consumables) from a description.',
    github:      'https://github.com/JamesCfer/D-Ditemmaker',
    install:     'https://github.com/JamesCfer/D-Ditemmaker/releases/latest',
  },
  {
    id:          'Pf2eStoreGenerator',
    system:      'pf2e',
    label:       'PF2e Store',
    icon:        'fa-solid fa-store',
    accentClass: 'card--pf2estore',
    description: 'Generate complete PF2e stores — shopkeeper, flavour, and a stocked inventory with prices.',
    github:      'https://github.com/JamesCfer/Pf2eStoreGenerator',
    install:     'https://github.com/JamesCfer/Pf2eStoreGenerator/releases/latest',
  },
  {
    id:          'Dnd5eStoreGenerator',
    system:      'dnd5e',
    label:       'D&D Store',
    icon:        'fa-solid fa-shop',
    accentClass: 'card--dnd5estore',
    description: 'Generate complete D&D 5e stores — shopkeeper, flavour, and a stocked inventory with prices.',
    github:      'https://github.com/JamesCfer/Dnd5eStoreGenerator',
    install:     'https://github.com/JamesCfer/Dnd5eStoreGenerator/releases/latest',
  },
  {
    id:          'Pf2eNationsAndCitiesMaker',
    system:      'pf2e',
    label:       'PF2e Settlements',
    icon:        'fa-solid fa-city',
    accentClass: 'card--pf2esettle',
    description: 'Generate PF2e cities, towns and nations with stores, guards, leadership, and economy.',
    github:      'https://github.com/JamesCfer/Pf2eNationsAndCitiesMaker',
    install:     'https://github.com/JamesCfer/Pf2eNationsAndCitiesMaker/releases/latest',
  },
  {
    id:          'Pf2eCalendarTimeline',
    system:      'pf2e',
    label:       'PF2e Calendar',
    icon:        'fa-solid fa-calendar-days',
    accentClass: 'card--pf2ecal',
    description: 'Customisable in-world calendar with scheduled events (taxes, paydays, festivals).',
    github:      'https://github.com/JamesCfer/Pf2eCalendarTimeline',
    install:     'https://github.com/JamesCfer/Pf2eCalendarTimeline/releases/latest',
  },
];

/**
 * @param {string} id
 * @returns {ModuleMetadata|null}
 */
export function getModuleMeta(id) {
  return ALL_MODULES.find(m => m.id === id) || null;
}
