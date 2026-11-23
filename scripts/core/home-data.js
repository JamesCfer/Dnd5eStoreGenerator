/**
 * Metadata for every module in the family.
 * The home page and the "More modules by Cfer" settings menu advertise the
 * entries that fit the user's game system (see promo.js).
 */

/**
 * @typedef {object} ModuleMetadata
 * @property {string} id           Foundry module id.
 * @property {string[]} systems    Foundry game system ids it runs on; empty means any system.
 * @property {string} label        Short display name for the home card.
 * @property {string} icon         FontAwesome class string.
 * @property {string} accentClass  CSS class applied to the home card for system colour.
 * @property {string} description  One-sentence summary shown on the home card.
 * @property {string} github       Repository URL.
 * @property {string} install      Latest-release URL used as the install link.
 * @property {string} manifest     Manifest URL to paste into Foundry's Install Module dialog.
 * @property {string} pitch        Short line for the one-line builder strip.
 */

/** @type {ModuleMetadata[]} */
export const ALL_MODULES = [
  {
    id:          'Pf2eNpcMaker',
    systems:     ['pf2e'],
    label:       'Pathfinder 2e NPC',
    icon:        'fa-solid fa-dragon',
    accentClass: 'card--pf2e',
    description: 'Generate fully-statted PF2e NPCs from a description.',
    github:      'https://github.com/JamesCfer/Pf2eNpcMaker',
    install:     'https://github.com/JamesCfer/Pf2eNpcMaker/releases/latest',
    manifest:    'https://github.com/JamesCfer/Pf2eNpcMaker/releases/download/latest/module.json',
    pitch:       'Fully-statted PF2e NPCs from one sentence.',
  },
  {
    id:          'DnD5eNpcMaker',
    systems:     ['dnd5e'],
    label:       'D&D 5e NPC',
    icon:        'fa-solid fa-shield-halved',
    accentClass: 'card--dnd5e',
    description: 'Generate D&D 5e creatures with stat blocks, spells, and CR.',
    github:      'https://github.com/JamesCfer/DnD5eNpcMaker',
    install:     'https://github.com/JamesCfer/DnD5eNpcMaker/releases/latest',
    manifest:    'https://github.com/JamesCfer/DnD5eNpcMaker/releases/download/latest/module.json',
    pitch:       'D&D 5e stat blocks with spells and CR from one sentence.',
  },
  {
    id:          'Hero6eNpcMaker',
    systems:     ['hero6efoundryvttv2'],
    label:       'HERO System 6e',
    icon:        'fa-solid fa-bolt',
    accentClass: 'card--hero6e',
    description: 'Generate Hero System 6e characters and import the .hdc directly.',
    github:      'https://github.com/JamesCfer/Hero6eNpcMaker',
    install:     'https://github.com/JamesCfer/Hero6eNpcMaker/releases/latest',
    manifest:    'https://github.com/JamesCfer/Hero6eNpcMaker/releases/download/latest/module.json',
    pitch:       'HERO 6e characters, imported straight from the .hdc.',
  },
  {
    id:          'Pf2eItemGenerator',
    systems:     ['pf2e'],
    label:       'Pathfinder 2e Item',
    icon:        'fa-solid fa-flask',
    accentClass: 'card--pf2eitem',
    description: 'Generate PF2e items (weapons, armor, consumables, treasure) from a description.',
    github:      'https://github.com/JamesCfer/Pf2eItemMaker',
    install:     'https://github.com/JamesCfer/Pf2eItemMaker/releases/latest',
    manifest:    'https://github.com/JamesCfer/Pf2eItemMaker/releases/download/latest/module.json',
    pitch:       'Custom PF2e weapons, armor and treasure in seconds.',
  },
  {
    id:          'Dnd5eItemGenerator',
    systems:     ['dnd5e'],
    label:       'D&D 5e Item',
    icon:        'fa-solid fa-hat-wizard',
    accentClass: 'card--dnd5eitem',
    description: 'Generate D&D 5e magic items (weapons, armor, wondrous items, consumables) from a description.',
    github:      'https://github.com/JamesCfer/D-Ditemmaker',
    install:     'https://github.com/JamesCfer/D-Ditemmaker/releases/latest',
    manifest:    'https://github.com/JamesCfer/D-Ditemmaker/releases/download/latest/module.json',
    pitch:       'Custom 5e magic items in seconds.',
  },
  {
    id:          'Pf2eStoreGenerator',
    systems:     ['pf2e'],
    label:       'PF2e Store',
    icon:        'fa-solid fa-store',
    accentClass: 'card--pf2estore',
    description: 'Generate complete PF2e stores — shopkeeper, flavour, and a stocked inventory with prices.',
    github:      'https://github.com/JamesCfer/Pf2eStoreGenerator',
    install:     'https://github.com/JamesCfer/Pf2eStoreGenerator/releases/latest',
    manifest:    'https://github.com/JamesCfer/Pf2eStoreGenerator/releases/download/latest/module.json',
    pitch:       'A shopkeeper and a priced inventory, ready for your players.',
  },
  {
    id:          'Dnd5eStoreGenerator',
    systems:     ['dnd5e'],
    label:       'D&D Store',
    icon:        'fa-solid fa-shop',
    accentClass: 'card--dnd5estore',
    description: 'Generate complete D&D 5e stores — shopkeeper, flavour, and a stocked inventory with prices.',
    github:      'https://github.com/JamesCfer/Dnd5eStoreGenerator',
    install:     'https://github.com/JamesCfer/Dnd5eStoreGenerator/releases/latest',
    manifest:    'https://github.com/JamesCfer/Dnd5eStoreGenerator/releases/download/latest/module.json',
    pitch:       'A shopkeeper and a priced inventory, ready for your players.',
  },
  {
    id:          'Pf2eNationsAndCitiesMaker',
    systems:     ['pf2e'],
    label:       'PF2e Settlements',
    icon:        'fa-solid fa-city',
    accentClass: 'card--pf2esettle',
    description: 'Generate PF2e cities, towns and nations with stores, guards, leadership, and economy.',
    github:      'https://github.com/JamesCfer/Pf2eNationsAndCitiesMaker',
    install:     'https://github.com/JamesCfer/Pf2eNationsAndCitiesMaker/releases/latest',
    manifest:    'https://github.com/JamesCfer/Pf2eNationsAndCitiesMaker/releases/download/latest/module.json',
    pitch:       'Whole towns and nations with stores, guards and leaders.',
  },
  {
    id:          'Pf2eCalendarTimeline',
    systems:     ['pf2e'],
    label:       'PF2e Calendar',
    icon:        'fa-solid fa-calendar-days',
    accentClass: 'card--pf2ecal',
    description: 'Customisable in-world calendar with scheduled events (taxes, paydays, festivals).',
    github:      'https://github.com/JamesCfer/Pf2eCalendarTimeline',
    install:     'https://github.com/JamesCfer/Pf2eCalendarTimeline/releases/latest',
    manifest:    'https://github.com/JamesCfer/Pf2eCalendarTimeline/releases/download/latest/module.json',
    pitch:       'An in-world calendar that fires paydays, taxes and festivals.',
  },
  {
    id:          'ai-battle-map-maker',
    systems:     [],
    label:       'AI Battle Map Maker',
    icon:        'fa-solid fa-map',
    accentClass: 'card--maps',
    description: 'Turn a description into a gridless battle map scene with walls and lighting, for any system.',
    github:      'https://github.com/JamesCfer/ai-battle-map-maker',
    install:     'https://github.com/JamesCfer/ai-battle-map-maker/releases/latest',
    manifest:    'https://github.com/JamesCfer/ai-battle-map-maker/releases/download/latest/module.json',
    pitch:       'Describe a place and get a battle map scene with walls and lights.',
  },
];

/**
 * @param {string} id
 * @returns {ModuleMetadata|null}
 */
export function getModuleMeta(id) {
  return ALL_MODULES.find(m => m.id === id) || null;
}
