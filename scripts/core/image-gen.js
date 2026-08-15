/**
 * NPC image generation — POSTs to the shared n8n image endpoint, downloads
 * the returned URL, uploads it into Foundry's user data, and (optionally)
 * patches the originating actor's portrait.
 */

import { N8N_ENDPOINTS, PATREON_URL, devUrl } from './n8n.js';
import { updateUsageFromResponse }            from './usage.js';

/** Number of monthly NPC uses charged per image generation. */
export const IMAGE_COST = 4;

/**
 * Generate an AI portrait for an NPC, then upload it to Foundry's user-data directory.
 *
 * @param {object}   opts
 * @param {object}   opts.npcData         The actor's plain data object (e.g. `actor.toObject()`).
 * @param {string}   opts.system          Foundry game system id ('pf2e', 'dnd5e', …).
 * @param {string}   [opts.artStyle='']   Optional free-text art style override.
 * @param {string}   opts.key             Patreon session key.
 * @param {boolean}  [opts.devMode=false] Route requests to the -dev endpoints.
 * @param {() => void}      [opts.onAuthFailed]   Called when the server returns 401/403.
 * @param {(data: object) => void} [opts.onRateLimited] Called when the server returns 429.
 * @returns {Promise<{ savedPath: string|null, message: string }>}
 */
export async function generateImage({
  npcData,
  system,
  artStyle = '',
  key,
  devMode = false,
  onAuthFailed,
  onRateLimited,
}) {
  const payload = {
    npcData: JSON.parse(JSON.stringify(npcData)),
    system,
    artStyle: artStyle || '',
  };

  const response = await fetch(devUrl(N8N_ENDPOINTS.image, devMode), {
    method:  'POST',
    headers: {
      'Content-Type':     'application/json',
      'X-Builder-Key':    key,
      'X-Foundry-Origin': window.location.origin,
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 401 || response.status === 403) {
    onAuthFailed?.();
    throw new Error('Authentication failed. Please sign in again.');
  }

  if (response.status === 429) {
    const data = await response.json().catch(() => ({}));
    updateUsageFromResponse(response, data);
    onRateLimited?.(data);
    throw new Error(data?.message || 'Monthly limit reached.');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.message || `Server returned status ${response.status}`);
  }

  const data = await response.json();
  updateUsageFromResponse(response, data);
  if (!data?.imageUrl) return { savedPath: null, message: 'Image generation request sent.' };

  // Download and re-upload into Foundry's data directory
  const imgResp = await fetch(data.imageUrl);
  if (!imgResp.ok) throw new Error(`Image fetch failed: ${imgResp.status}`);
  const blob = await imgResp.blob();

  const slug = (npcData.name || 'npc')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 48);
  const uid  = foundry.utils.randomID(8);
  const ext  = blob.type === 'image/webp' ? 'webp' : (blob.type === 'image/png' ? 'png' : 'webp');
  const filename = `${slug}-${uid}.${ext}`;

  const folder = 'npc-images';
  try { await FilePicker.createDirectory('data', folder, {}); } catch (_) {}

  const file   = new File([blob], filename, { type: blob.type });
  const result = await FilePicker.upload('data', folder, file, {});
  return { savedPath: result?.path ?? `${folder}/${filename}`, message: 'Image saved.' };
}

export { PATREON_URL };
