/**
 * Cross-promotion between the Cfer modules.
 *
 * Three surfaces, all quiet by design:
 *   - the "More modules by Cfer" section on the builder's Home tab,
 *   - a one-line strip under the builder form (dismissible, 30 days, shared
 *     across every Cfer module because they share the browser origin),
 *   - a "More modules by Cfer" button in each module's settings section,
 *     which also covers modules without a builder (the calendar).
 */

import { ALL_MODULES } from './home-data.js';
import { escapeHtml }  from './utils.js';

export const PROMO_DISMISS_KEY = 'cfer-promo-dismissed-until';
export const PROMO_DISMISS_DAYS = 30;

/** @param {import('./home-data.js').ModuleMetadata} meta */
export function runsOnSystem(meta, systemId) {
  return !meta.systems?.length || !systemId || meta.systems.includes(systemId);
}

/**
 * The siblings worth showing: same game system (or system-agnostic), not the
 * running module, and not already installed and enabled. Installed-but-disabled
 * modules stay in the list with `installedInactive` so we can point at the
 * Manage Modules screen instead of a manifest URL.
 *
 * @param {{ currentId: string, systemId?: string, modules?: Map|{get:Function} }} opts
 */
export function promoModulesFor({ currentId, systemId, modules, all = ALL_MODULES }) {
  return all
    .filter(m => m.id !== currentId && runsOnSystem(m, systemId))
    .map(m => {
      const installed = modules?.get?.(m.id);
      return { ...m, installedInactive: !!installed && !installed.active, active: !!installed?.active };
    })
    .filter(m => !m.active);
}

/**
 * One sibling for the builder strip. The battle map maker leads because it
 * works on every system; otherwise rotate by day so it doesn't feel static.
 */
export function pickStripModule(promos, now = Date.now()) {
  const fresh = promos.filter(m => !m.installedInactive);
  if (!fresh.length) return null;
  const maps = fresh.find(m => m.id === 'ai-battle-map-maker');
  if (maps) return maps;
  return fresh[Math.floor(now / 86_400_000) % fresh.length];
}

export function isStripDismissed(now = Date.now(), store = globalThis.localStorage) {
  try { return Number(store?.getItem(PROMO_DISMISS_KEY) || 0) > now; }
  catch { return false; }
}

export function dismissStrip(now = Date.now(), store = globalThis.localStorage) {
  try { store?.setItem(PROMO_DISMISS_KEY, String(now + PROMO_DISMISS_DAYS * 86_400_000)); }
  catch { /* private mode: the strip just comes back next session */ }
}

export async function copyManifest(url) {
  try {
    await navigator.clipboard.writeText(url);
    ui.notifications?.info?.('Manifest URL copied. In Foundry setup, open Add-on Modules, Install Module, and paste it into Manifest URL.');
  } catch {
    ui.notifications?.info?.(`Manifest URL: ${url}`);
  }
}

/** Wire copy buttons inside a rendered element. */
export function bindPromoButtons(root) {
  for (const btn of root.querySelectorAll('[data-copy-manifest]')) {
    btn.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      copyManifest(btn.dataset.copyManifest);
    });
  }
}

export function renderPromoList(promos) {
  if (!promos.length) {
    return '<p class="cfer-promo-empty">You already have every Cfer module for this game system. Thank you!</p>';
  }
  return `<ul class="cfer-promo-list">${promos.map(m => `
    <li class="cfer-promo-item">
      <i class="${escapeHtml(m.icon)}" aria-hidden="true"></i>
      <div class="cfer-promo-body">
        <strong>${escapeHtml(m.label)}</strong>
        <span>${escapeHtml(m.description)}</span>
      </div>
      <div class="cfer-promo-actions">
        ${m.installedInactive
          ? '<span class="cfer-promo-note">Installed. Enable it in Manage Modules.</span>'
          : `<button type="button" data-copy-manifest="${escapeHtml(m.manifest)}"><i class="fa-solid fa-copy"></i> Copy install link</button>`}
        <a href="${escapeHtml(m.github)}" target="_blank" rel="noopener noreferrer">Details</a>
      </div>
    </li>`).join('')}</ul>`;
}

/**
 * Adds a "More modules by Cfer" button to this module's settings section.
 * Call from the module's `init` hook.
 */
export function registerPromoMenu(moduleId) {
  const { ApplicationV2 } = foundry.applications.api;
  class CferModulesMenu extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: `${moduleId}-more-modules`,
      classes: ['cfer-promo-window'],
      window: { title: 'More modules by Cfer', icon: 'fa-solid fa-puzzle-piece' },
      position: { width: 520, height: 'auto' },
    };
    async _renderHTML() {
      const promos = promoModulesFor({ currentId: moduleId, systemId: game.system?.id, modules: game.modules });
      return `<div class="cfer-promo">
        <p>Every Cfer module shares one Patreon sign-in and one monthly allowance, so adding another costs nothing extra.</p>
        ${renderPromoList(promos)}
      </div>`;
    }
    _replaceHTML(result, content) {
      content.innerHTML = result;
      bindPromoButtons(content);
    }
  }
  game.settings.registerMenu(moduleId, 'moreModules', {
    name:  'More modules by Cfer',
    label: 'Browse modules',
    hint:  'Other Cfer modules for your game system. They share your sign-in and monthly uses.',
    icon:  'fa-solid fa-puzzle-piece',
    type:  CferModulesMenu,
    restricted: false,
  });
}
