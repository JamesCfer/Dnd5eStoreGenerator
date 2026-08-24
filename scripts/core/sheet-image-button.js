/**
 * Shared helper for the "Generate Image" button injected into actor/item sheets.
 *
 * The button is deliberately unobtrusive: it is mounted directly beneath the
 * sheet's portrait/icon (never in the middle of the header, where it would
 * squeeze the rest of the fields), and it is only shown while the document is
 * still using its default artwork.
 */

/** Image paths Foundry / the systems hand out as placeholder artwork. */
const DEFAULT_IMG_PATTERNS = [
  /^icons\/svg\//i,
  /default-icons/i,
  /mystery-man/i,
  /^icons\/containers\/bags\/sack-simple-brown\.webp$/i,
];

/**
 * Is this document still using placeholder artwork?
 *
 * @param {ClientDocument} doc
 * @returns {boolean} True when no bespoke image has been set yet.
 */
export function hasDefaultImage(doc) {
  const img = doc?.img;
  if (!img) return true;

  // Foundry v11+ exposes the exact default artwork for a document's subtype.
  try {
    const source  = doc.toObject?.() ?? doc;
    const defImg  = doc.constructor?.getDefaultArtwork?.(source)?.img;
    if (defImg && defImg === img) return true;
  } catch (_) { /* fall through to the pattern check */ }

  if (img === globalThis.CONST?.DEFAULT_TOKEN) return true;

  return DEFAULT_IMG_PATTERNS.some(re => re.test(img));
}

/**
 * Locate the portrait/icon element of a rendered sheet.
 *
 * @param {HTMLElement} root Sheet root element.
 * @returns {HTMLImageElement|null}
 */
function findPortrait(root) {
  return (
    root.querySelector('img.profile') ||
    root.querySelector('img.profile-img') ||
    root.querySelector('img[data-edit="img"]') ||
    root.querySelector('.sheet-header img') ||
    root.querySelector('.window-content img') ||
    null
  );
}

/**
 * Inject the Generate Image button under a sheet's portrait, if — and only if —
 * the document still has its default artwork.
 *
 * @param {object} opts
 * @param {HTMLElement}    opts.root    Rendered sheet root element.
 * @param {ClientDocument} opts.doc     Actor or Item the sheet belongs to.
 * @param {string}         opts.title   Tooltip text.
 * @param {() => void}     opts.onClick Click handler.
 * @returns {boolean} True when the button was injected.
 */
export function injectSheetImageButton({ root, doc, title, onClick }) {
  if (!root || !doc) return false;
  if (root.querySelector('.npc-builder-sheet-image-btn')) return false;
  if (!hasDefaultImage(doc)) return false;

  const img = findPortrait(root);
  if (!img?.parentElement) return false;

  // Stack the button under the portrait without disturbing the header layout.
  let slot = img.closest('.npc-builder-image-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.className = 'npc-builder-image-slot';
    img.parentElement.insertBefore(slot, img);
    slot.appendChild(img);
  }

  const btn = document.createElement('button');
  btn.type      = 'button';
  btn.className = 'npc-builder-sheet-image-btn';
  btn.innerHTML = '<i class="fa-solid fa-image"></i><span class="btn-image-label">Generate</span>';
  btn.title     = title;
  btn.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    onClick();
  });
  slot.appendChild(btn);
  return true;
}
