/**
 * A photo or a PDF made ready to upload, and what a file weighs in words.
 * Tasks, Projects and Notes each had a copy of this; it is here once.
 *
 * A phone photo is 3–5 MB, and sending that with two bars of signal is
 * standing there waiting. Reduced to 2000 px on its long side it comes to about
 * 300 kB, goes at once, and a label, an invoice or a whiteboard still reads.
 * It is done in the browser and not on the server because the suite has no
 * dependencies, and resizing images in Node without libraries isn't sensible:
 * the browser already has the canvas.
 *
 * Things that look like details and are not:
 *
 * · **Orientation.** An upright iPhone photo is stored lying down with an EXIF
 *   note that says "turn it". Through a canvas the note is lost and the photo
 *   comes out on its side, so it is decoded asking for the turn already applied.
 * · **A white ground.** A JPEG has no transparency: a transparent PNG's gaps
 *   would come out black.
 * · **A GIF may move.** Through a canvas only its first frame would be left,
 *   so it goes as it is, if it fits.
 * · **What the server takes** is JPEG, PNG, GIF, WebP and PDF, by their first
 *   bytes (uploads.js). A small picture of another kind (an iPhone's HEIC) is
 *   still made a JPEG, or the server would refuse it.
 */
import { el } from './dom.js';
import { t, numberFormat } from './i18n.js';

/** The long side a picture is reduced to. At 2000 px an invoice reads without effort. */
export const MAX_SIDE = 2000;

/** JPEG quality: above it only the file grows. */
export const JPEG_QUALITY = 0.85;

/**
 * The most a file may weigh, when the page doesn't know the server's: the
 * default `maxBytes` of uploads.js. The server says its own in
 * /api/auth/config (`app.uploads.max_bytes`, read by `uploadLimit`): here it
 * warns before spending data, there it is the law.
 */
export const MAX_BYTES = 15 * 1024 * 1024;

/** Below this a picture the server takes goes as it is: compressing again would only spoil it. */
const ALREADY_SMALL = 500 * 1024;

/** The pictures the server takes as they are (GIF apart: see `prepareUpload`). */
const TAKEN = ['image/jpeg', 'image/png', 'image/webp'];

export const isPdf = (file) => file?.type === 'application/pdf';
export const isImage = (file) => String(file?.type || '').startsWith('image/');

/** The server's limit per file, from /api/auth/config; MAX_BYTES when it says none. */
export const uploadLimit = (config) => Number(config?.app?.uploads?.max_bytes) || MAX_BYTES;

/** Decodes a picture with its orientation already applied. */
async function decode(file) {
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch { /* not every browser takes the option: below, then */ }
  }
  // With <img> today's browsers apply the orientation on their own too.
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(t('kit.images.unreadable', { name: file.name })));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * A file ready to send: → `{ blob, name }`. A PDF goes as it is; a picture
 * small enough, too; a big one (or one the server wouldn't take) is reduced
 * to a JPEG of MAX_SIDE at most. Refusals are Errors with the sentence to show.
 *
 * @param {File} file
 * @param {object} [options]
 * @param {boolean} [options.keepGif=true]  a GIF as it is, so it keeps moving
 * @param {boolean} [options.asIs=false]    as it is whatever it is (a drawing's PNG made by the
 *   page, whose strokes a JPEG would blur), the size still checked
 * @param {number} [options.maxBytes]       the server's limit (`uploadLimit(config)`)
 */
export async function prepareUpload(file, { keepGif = true, asIs = false, maxBytes = MAX_BYTES } = {}) {
  const max = Number(maxBytes) || MAX_BYTES;
  const tooLarge = () => new Error(t('kit.images.tooLarge', { name: file.name, mb: Math.round(max / 1024 / 1024) }));
  const whole = () => {
    if (file.size > max) throw tooLarge();
    return { blob: file, name: file.name };
  };
  if (isPdf(file) || asIs) return whole();
  if (!isImage(file)) throw new Error(t('kit.images.onlyPhotosPdf'));
  if (keepGif && file.type === 'image/gif') return whole();

  const bitmap = await decode(file);
  const width = bitmap.width || bitmap.naturalWidth;
  const height = bitmap.height || bitmap.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  // Already small and nothing to shrink: it goes as it is. Compressing a
  // screenshot again only adds dirt to it.
  if (scale === 1 && file.size <= ALREADY_SMALL && TAKEN.includes(file.type)) {
    bitmap.close?.();
    return { blob: file, name: file.name };
  }
  const canvas = el('canvas', { width: String(Math.round(width * scale)), height: String(Math.round(height * scale)) });
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
  if (!blob) throw new Error(t('kit.images.unreadable', { name: file.name }));
  if (blob.size > max) throw tooLarge();
  // Made again it is always a JPEG, and the name says so: otherwise an iPhone's
  // HEIC would later download as "photo.heic" without being one.
  const base = String(file.name || '').replace(/\.[^.]+$/, '') || t('kit.images.defaultName');
  return { blob, name: `${base}.jpg` };
}

/**
 * "340 kB", "1.2 MB": what a file weighs, without dizzying anyone. The decimal
 * mark follows the language, and so does the unit (French writes "Mo").
 */
export function fileSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return t('kit.images.size.bytes', { n });
  if (n < 1024 * 1024) return t('kit.images.size.kb', { n: Math.round(n / 1024) });
  const megabytes = numberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(n / 1024 / 1024);
  return t('kit.images.size.mb', { n: megabytes });
}
