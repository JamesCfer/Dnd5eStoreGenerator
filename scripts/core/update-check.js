/**
 * Module update detector — fetches the live manifest, compares versions,
 * and shows a one-shot popup linking to the GitHub release page.
 */

import { isNewerVersion } from './utils.js';

/**
 * Fetches the live module manifest, compares versions, and shows a one-shot
 * update prompt when a newer version is available.
 *
 * @param {string} moduleId       Foundry module id (e.g. 'Pf2eNpcMaker').
 * @param {string} githubRepoUrl  GitHub repository root URL (e.g. 'https://github.com/Foo/Bar').
 *                                The function appends '/releases/latest' for the update link.
 */
export async function checkForModuleUpdate(moduleId, githubRepoUrl) {
  try {
    const mod            = game.modules?.get(moduleId);
    const manifestUrl    = mod?.manifest;
    const currentVersion = mod?.version || '';
    if (!manifestUrl || !currentVersion) return;

    const response = await fetch(manifestUrl, { cache: 'no-cache' });
    if (!response.ok) return;

    const data          = await response.json();
    const latestVersion = data?.version || '';
    if (!latestVersion || !isNewerVersion(latestVersion, currentVersion)) return;

    const content = `
      <div style="display:flex;flex-direction:column;gap:0.6em;padding:0.25em 0;">
        <p style="margin:0;">
          <strong>${mod?.title || moduleId} v${latestVersion}</strong> is available.
          You are running <strong>v${currentVersion}</strong>.
        </p>
        <p style="margin:0;color:#555;font-size:0.92em;">
          Update via the Foundry <em>Add-on Modules</em> manager or from GitHub.
        </p>
      </div>`;

    const DialogV2 = foundry.applications?.api?.DialogV2;
    const releasesUrl = `${githubRepoUrl}/releases/latest`;

    if (DialogV2) {
      DialogV2.prompt({
        window:  { title: `${mod?.title || moduleId} — Update Available` },
        content,
        ok: {
          label:    'View on GitHub',
          icon:     'fa-brands fa-github',
          callback: () => window.open(releasesUrl, '_blank'),
        },
        rejectClose: false,
      }).catch(() => {});
    } else {
      new Dialog({
        title:   `${mod?.title || moduleId} — Update Available`,
        content,
        buttons: {
          github:  {
            label:    '<i class="fa-brands fa-github"></i> View on GitHub',
            callback: () => window.open(releasesUrl, '_blank'),
          },
          dismiss: { label: 'Dismiss' },
        },
        default: 'dismiss',
      }).render(true);
    }
  } catch (err) {
    console.debug('[NPC Builder] Update check failed (offline?):', err);
  }
}
