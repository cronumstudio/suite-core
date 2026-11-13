/**
 * An item's photos and files, the same in every module (audit of 6/11, dup-css-12 and
 * ux-acciones-17): the «Archivos» section of a detail (attachments) and the photo viewer
 * (photoViewer), with the zoom Tasks had (makeZoomable).
 *
 * The section draws what it is given and asks the module for the rest: `upload` sends one file
 * (already made smaller by images.js), `remove` sends one to the trash and `restore` brings it back,
 * and the module keeps its own state with what its server answers. A photo is a square thumbnail
 * that opens the viewer; a PDF a row with its name and its size. One way to add them: the button,
 * a file dropped on the detail or pasted into it; one notice while several go up; the room left
 * said before uploading. Taking one away goes to the trash at once and leaves an Undo (web-kit.md,
 * rule 7).
 *
 * The viewer is a kit dialog, in the browser's top layer: in Cronum Work it covers the screen and
 * not only the module's window, which cuts off what is fixed inside it (windows.css).
 */
import { el } from './dom.js';
import { t, numberFormat } from './i18n.js';
import { icon } from './icons.js';
import { toast, undoToast, openDialog } from './ui.js';
import { errorMessage } from './api.js';
import { prepareUpload, fileSize, MAX_BYTES } from './images.js';

/** What a section takes by default: photos and PDFs. */
export const FILE_TYPES = 'image/*,application/pdf';

export const isPhotoFile = (file) => String(file?.mime || file?.type || '').startsWith('image/');

/** Whether a file the person chose, dropped or pasted is of a kind `accept` takes ("image/*,application/pdf"). */
function accepted(file, accept) {
  const kinds = String(accept || '').split(',').map((kind) => kind.trim().toLowerCase()).filter(Boolean);
  if (!kinds.length) return true;
  const type = String(file?.type || '').toLowerCase();
  const name = String(file?.name || '').toLowerCase();
  return kinds.some((kind) => (kind.endsWith('/*') ? type.startsWith(kind.slice(0, -1))
    : kind.startsWith('.') ? name.endsWith(kind) : type === kind));
}

/** The files in a drag or a paste, if it carries any. */
const carriedFiles = (data) => [...(data?.files || [])];
const carriesFiles = (data) => [...(data?.types || [])].includes('Files');

/** Puts a class on a node or takes it off, keeping its others. */
function toggleClass(node, name, on) {
  const names = String(node.getAttribute?.('class') || '').split(/s+/).filter((one) => one && one !== name);
  if (on) names.push(name);
  node.setAttribute?.('class', names.join(' '));
}

/** The listeners each detail has, so a section drawn again takes the place of the one before. */
const bound = new WeakMap();

/** A written field: a paste with words in it is the field's, not a file's. */
const writing = (node) => node?.isContentEditable || node?.tagName === 'TEXTAREA'
  || (node?.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'file', 'submit', 'range', 'color'].includes(node.type));

/**
 * The «Archivos» section of an item's detail. → the section node, or null when there is nothing to
 * show nor to do.
 *
 * - `files`: [{ id, name, mime, size }], what the item has.
 * - `editable`: whether files can be added (and taken away: `mayRemove(file)` narrows it, a file
 *   someone else added to a shared list).
 * - `fileUrl(file, { download })`: where a file is read, or downloaded.
 * - `upload(blob, name)`: sends one file; what it returns goes to `onUploaded` at the end.
 * - `onUploaded(results)`: the answers of the files that went up, once, after the last (the module
 *   draws its detail again with them: drawn after each, the section would be built under the
 *   person's finger while the rest go up).
 * - `remove(file)`: to the trash; `restore(file)`: back from it, for the Undo.
 * - `max`: how many an item may have (null: no limit here); `maxBytes`: a file's largest size.
 * - `dropTarget`: the node a file is dropped on or pasted into to add it (the detail).
 * - `accept`: the kinds of file it takes (photos and PDFs). `errorText(err)`: what went wrong, in words.
 * - `onPhoto(file, photos)`: what a thumbnail opens; the kit's viewer by default.
 * - `notice`: a line under the title (a reason it can't take files now, say).
 */
export function attachments({
  files = [], editable = false, mayRemove = () => true, fileUrl, upload = null, onUploaded = () => {},
  remove = null, restore = null, max = null, maxBytes = MAX_BYTES, dropTarget = null, accept = FILE_TYPES,
  errorText = (err) => err?.message || errorMessage(err), onPhoto = null, notice = null,
}) {
  const list = files || [];
  if (!list.length && !editable) return null;
  const photos = list.filter(isPhotoFile);
  const full = max != null && list.length >= max;
  const title = el('h3', { class: 'kit-files__title' },
    el('span', { text: t('kit.files.title') }),
    list.length ? el('span', { class: 'kit-files__count', text: numberFormat().format(list.length) }) : null);
  const section = el('section', { class: 'kit-files' }, title,
    notice ? el('p', { class: 'kit-hint', text: notice }) : null);

  const open = (file) => (onPhoto || ((one) => photoViewer({ photos, start: one, fileUrl })))(file, photos);
  if (list.length) {
    section.append(el('div', { class: 'kit-files__grid' }, list.map((file) => tile(file, {
      open, fileUrl,
      removable: editable && remove && mayRemove(file),
      onRemove: () => takeAway(file),
    }))));
  } else {
    section.append(el('p', { class: 'kit-hint kit-files__none', text: t('kit.files.none') }));
  }

  async function takeAway(file) {
    try {
      await remove(file);
    } catch (err) {
      toast(errorText(err), { error: true });
      return;
    }
    undoToast(t('kit.files.trashed', { name: file.name }), async () => {
      try { await restore?.(file); } catch (err) { toast(errorText(err), { error: true }); }
    });
  }

  if (!editable || !upload) return section;
  if (full) {
    section.append(el('p', { class: 'kit-hint', text: t('kit.files.full', { max }) }));
    return section;
  }

  const input = el('input', { type: 'file', accept, multiple: true, hidden: true, class: 'kit-files__input' });
  const words = el('span', { text: t('kit.files.add') });
  const button = el('button', { type: 'button', class: 'kit-btn kit-btn--small kit-files__add' }, icon('clip'), words);
  button.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const chosen = [...input.files];
    input.value = '';   // so choosing the same file again counts
    add(chosen);
  });
  section.append(button, input,
    dropTarget ? el('p', { class: 'kit-hint kit-files__drop', text: t('kit.files.dropHint') }) : null);

  let going = false;
  /** Sends the files one after another, saying where it is, and tells what didn't go. */
  async function add(chosen) {
    if (going || !chosen.length) return;
    const fitting = chosen.filter((file) => accepted(file, accept));
    if (fitting.length < chosen.length) toast(t('kit.files.notThisKind'), { error: true });
    if (!fitting.length) return;
    const room = max == null ? fitting.length : Math.max(0, max - list.length);
    if (fitting.length > room) toast(t('kit.files.roomLeft', { n: room }), { error: true });
    const sending = fitting.slice(0, room);
    if (!sending.length) return;
    going = true;
    button.disabled = true;
    const results = [];
    const failures = [];
    for (const [i, file] of sending.entries()) {
      words.textContent = sending.length > 1 ? t('kit.files.uploadingOf', { current: i + 1, total: sending.length }) : t('kit.files.uploading');
      try {
        const { blob, name } = await prepareUpload(file, { maxBytes });
        results.push(await upload(blob, name));
      } catch (err) {
        failures.push(sending.length > 1 ? `${file.name}: ${errorText(err)}` : errorText(err));
      }
    }
    going = false;
    button.disabled = false;
    words.textContent = t('kit.files.add');
    if (failures.length && results.length) toast(t('kit.files.someFailed', { n: results.length, total: sending.length, error: failures[0] }), { error: true });
    else if (failures.length) toast(failures[0], { error: true });
    else if (results.length > 1) toast(t('kit.files.added', { n: results.length }));
    if (results.length) onUploaded(results);
  }

  if (dropTarget) bindDrop(dropTarget, section, add);
  return section;
}

/**
 * A file dropped on the detail, or pasted into it, is added as the button adds it. Bound once per
 * detail: a section drawn again takes the listeners of the one before, and a section that is gone
 * (another item open, one that can't take files) lets them go.
 */
function bindDrop(target, section, add) {
  bound.get(target)?.abort();
  const control = new AbortController();
  bound.set(target, control);
  const { signal } = control;
  const live = () => {
    if (section.isConnected !== false) return true;
    control.abort();
    toggleClass(target, 'kit-files-over', false);
    return false;
  };
  let depth = 0;
  target.addEventListener('dragenter', (ev) => {
    if (!carriesFiles(ev.dataTransfer) || !live()) return;
    depth += 1;
    toggleClass(target, 'kit-files-over', true);
  }, { signal });
  target.addEventListener('dragover', (ev) => {
    if (!carriesFiles(ev.dataTransfer) || !live()) return;
    // Taken: without it the browser opens the photo in place of the app.
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  }, { signal });
  target.addEventListener('dragleave', (ev) => {
    if (!carriesFiles(ev.dataTransfer)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) toggleClass(target, 'kit-files-over', false);
  }, { signal });
  target.addEventListener('drop', (ev) => {
    depth = 0;
    toggleClass(target, 'kit-files-over', false);
    const dropped = carriedFiles(ev.dataTransfer);
    if (!dropped.length || !live()) return;
    ev.preventDefault();
    add(dropped);
  }, { signal });
  target.addEventListener('paste', (ev) => {
    const pasted = carriedFiles(ev.clipboardData);
    if (!pasted.length || !live()) return;
    // Words pasted into a field are the field's; a picture alone (a screenshot) is a file.
    if (writing(ev.target) && ev.clipboardData?.getData?.('text/plain')) return;
    ev.preventDefault();
    add(pasted);
  }, { signal });
}

/** A photo as a square thumbnail that opens it; a PDF as a row with its name and size. */
function tile(file, { open, fileUrl, removable, onRemove }) {
  const removeButton = removable ? el('button', {
    type: 'button', class: 'kit-files__remove',
    title: t('kit.files.remove', { name: file.name }), 'aria-label': t('kit.files.remove', { name: file.name }),
    onClick: (ev) => { ev.stopPropagation?.(); onRemove(); },
  }, icon('x')) : null;
  if (isPhotoFile(file)) {
    return el('div', { class: 'kit-file kit-file--photo' },
      el('button', {
        type: 'button', class: 'kit-file__open', title: `${file.name} · ${fileSize(file.size)}`,
        'aria-label': t('kit.files.open', { name: file.name }), onClick: () => open(file),
      }, el('img', { src: fileUrl(file), alt: file.name, loading: 'lazy' })),
      removeButton);
  }
  return el('div', { class: 'kit-file kit-file--doc' },
    el('a', { class: 'kit-file__link', href: fileUrl(file), target: '_blank', rel: 'noopener', title: file.name },
      icon('notes'),
      el('span', { class: 'kit-file__name', text: file.name }),
      el('span', { class: 'kit-file__size', text: fileSize(file.size) })),
    removeButton);
}

/* --------------------------------- viewer --------------------------------- */

/**
 * A photo at full size in a kit dialog, with its download and, when there are several, the arrows
 * to the others (and the keyboard's): pinch, a double tap or the wheel enlarge it (makeZoomable).
 * `photos` [{ id, name }], `start` the one to show first, `fileUrl(file, { download })`. `parent` as
 * openDialog's. → { close }.
 */
export function photoViewer({ photos, start = null, fileUrl, parent = null }) {
  const all = (photos || []).filter(Boolean);
  if (!all.length) return { close: () => {} };
  let at = Math.max(0, all.findIndex((file) => file === start || (start && file.id === start.id)));
  const image = el('img', { class: 'kit-viewer__photo', alt: '' });
  // The frame crops: zoomed in, the photo spills out on all sides and must not leave the dialog.
  const frame = el('div', { class: 'kit-viewer__frame' }, image);
  const counter = el('span', { class: 'kit-viewer__counter' });
  const magnified = el('span', { class: 'kit-viewer__zoom' });
  const download = el('a', { class: 'kit-btn kit-btn--primary', download: '' }, icon('download'), el('span', { text: t('kit.photo.download') }));
  let zoom = null;

  const paint = () => {
    const file = all[at];
    image.src = fileUrl(file);
    image.alt = file.name || '';
    download.href = fileUrl(file, { download: true });
    download.setAttribute('download', file.name || '');
    // Not its name ("IMG_4821.jpg" says nothing): which one of how many, when there are several.
    counter.textContent = all.length > 1 ? t('kit.photo.counter', { index: at + 1, total: all.length }) : '';
    // Each photo starts at its own size, not the last one's magnification.
    zoom?.reset();
  };
  const move = (step) => { at = (at + step + all.length) % all.length; paint(); };
  const arrow = (step, name, label) => el('button', {
    type: 'button', class: 'kit-icon-btn kit-viewer__step', title: label, 'aria-label': label, onClick: () => move(step),
  }, icon(name));

  const body = el('div', { class: 'kit-viewer' },
    frame,
    el('div', { class: 'kit-viewer__bar' },
      all.length > 1 ? arrow(-1, 'back', t('kit.photo.previous')) : null,
      counter, magnified,
      all.length > 1 ? el('span', { class: 'kit-viewer__next' }, arrow(1, 'chevron', t('kit.photo.next'))) : null),
    el('small', { class: 'kit-hint kit-viewer__help', text: t('kit.photo.help'), 'data-wheel-hint': t('kit.photo.wheelHint') }));
  const { dialog, close } = openDialog({
    title: t('kit.photo.title'),
    width: 'min(920px, 96vw)',
    className: 'kit-dialog--viewer',
    parent,
    body,
    footer: el('footer', {}, download),
    onClose: () => zoom?.destroy(),
  });
  // The arrows flip through them; it is what one tries without thinking. On the dialog: modal, it
  // has the keyboard while it is open, in Cronum Work's windows too.
  dialog.addEventListener('keydown', (ev) => {
    if (all.length < 2 || ev.target?.closest?.('input, textarea, select')) return;
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); move(-1); }
    if (ev.key === 'ArrowRight') { ev.preventDefault(); move(1); }
  });
  zoom = makeZoomable(frame, image, (scale) => {
    magnified.textContent = scale > 1.02 ? `${numberFormat({ minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(scale)}×` : '';
  });
  paint();
  return { close, dialog };
}

/* ---------------------------------- zoom ---------------------------------- */

/** How far it can be enlarged: eight times a 2000 px photo is looking at its grain. */
const MAX_SCALE = 8;
/** How much a double tap enlarges. */
const JUMP = 2.5;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * Makes the image inside `frame` (a box with `overflow: hidden`) enlargeable: pinch, double tap or
 * double click, the wheel, and dragging it once enlarged. The browser's own zoom is off in the
 * apps, and a photo still has to be looked at up close: this one starts and ends at the photo's
 * frame. The point pinched stays still, and the photo always keeps touching the frame; at its own
 * size it goes back to the middle. It moves with `transform`, which the graphics card does.
 * `onChange(scale)` is told the magnification. → { reset, destroy }.
 */
export function makeZoomable(frame, image, onChange = () => {}) {
  let scale = 1;
  let x = 0;
  let y = 0;
  const fingers = new Map();
  let pinch = null;
  let dragging = null;
  let lastTap = 0;
  const control = new AbortController();
  const { signal } = control;

  const paint = () => {
    image.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    toggleClass(frame, 'kit-viewer__frame--zoomed', scale > 1);
    onChange(scale);
  };
  /** The offset kept so that the photo keeps touching the frame; smaller than it, centred. */
  const fit = () => {
    const box = frame.getBoundingClientRect();
    // offsetWidth is the size without transforms: what it has at scale 1.
    const slackX = Math.max(0, (image.offsetWidth * scale - box.width) / 2);
    const slackY = Math.max(0, (image.offsetHeight * scale - box.height) / 2);
    x = clamp(x, -slackX, slackX);
    y = clamp(y, -slackY, slackY);
  };
  /** From `scale` to `next`, keeping the screen point (px, py) where it is. */
  const zoomAt = (next, px, py) => {
    const target = clamp(next, 1, MAX_SCALE);
    if (target === scale) return;
    const box = frame.getBoundingClientRect();
    const cx = box.left + box.width / 2;
    const cy = box.top + box.height / 2;
    const k = target / scale;
    x = (px - cx) * (1 - k) + x * k;
    y = (py - cy) * (1 - k) + y * k;
    scale = target;
    if (scale === 1) { x = 0; y = 0; } else fit();
    paint();
  };
  const reset = () => {
    scale = 1; x = 0; y = 0;
    fingers.clear();
    pinch = null;
    dragging = null;
    image.style.transition = '';
    paint();
  };
  /** A double tap with a short transition, not a dry jump. */
  const smoothly = (fn) => {
    image.style.transition = 'transform .18s ease-out';
    fn();
    setTimeout(() => { image.style.transition = ''; }, 200);
  };

  frame.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button > 0) return;
    // Captured, the gesture goes on when the finger leaves the frame; it can fail (a pointer gone).
    try { frame.setPointerCapture?.(e.pointerId); } catch { /* without the capture */ }
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (fingers.size === 2) {
      const [a, b] = [...fingers.values()];
      pinch = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale };
      dragging = null;
      // A pinch is not a tap: the next touch isn't the second of a double tap.
      lastTap = 0;
      return;
    }
    const now = Date.now();
    if (now - lastTap < 300 && fingers.size === 1) {
      lastTap = 0;
      smoothly(() => (scale > 1 ? zoomAt(1, e.clientX, e.clientY) : zoomAt(JUMP, e.clientX, e.clientY)));
      return;
    }
    lastTap = now;
    if (scale > 1) dragging = { x: e.clientX, y: e.clientY };
  }, { signal });
  frame.addEventListener('pointermove', (e) => {
    if (!fingers.has(e.pointerId)) return;
    fingers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && fingers.size >= 2) {
      const [a, b] = [...fingers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (!distance) return;
      e.preventDefault();
      zoomAt(pinch.scale * (distance / pinch.distance), (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    if (dragging && scale > 1) {
      e.preventDefault();
      x += e.clientX - dragging.x;
      y += e.clientY - dragging.y;
      dragging = { x: e.clientX, y: e.clientY };
      lastTap = 0;
      fit();
      paint();
    }
  }, { passive: false, signal });
  const up = (e) => {
    fingers.delete(e.pointerId);
    if (fingers.size < 2) pinch = null;
    // The finger that stays after a pinch drags from where it is, without a jump.
    if (fingers.size === 1 && scale > 1) {
      const [q] = [...fingers.values()];
      dragging = { x: q.x, y: q.y };
    }
    if (!fingers.size) dragging = null;
  };
  frame.addEventListener('pointerup', up, { signal });
  frame.addEventListener('pointercancel', up, { signal });
  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(scale * Math.exp(-e.deltaY * 0.0022), e.clientX, e.clientY);
  }, { passive: false, signal });
  // A phone turned changes the frame: the photo is kept inside it.
  globalThis.window?.addEventListener?.('resize', () => { fit(); paint(); }, { signal });

  return { reset, destroy: () => control.abort() };
}
