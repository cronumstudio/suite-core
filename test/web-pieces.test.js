/**
 * The kit's pieces every module shares since the audit of 6/11 (dup-css-2 and -12, ux-acciones-17
 * and -18, ui-dialogos-8): placeFixed (a floating box inside a window of Cronum Work), the search's
 * results (highlight, searchSection, searchResults), the short date, time and «ago» (i18n.js), and
 * an item's files with the photo viewer (files.js).
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
globalThis.window = { innerWidth: 390, innerHeight: 800 };
FakeElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
for (const name of ['offsetWidth', 'offsetHeight']) Object.defineProperty(FakeElement.prototype, name, { get: () => 0, configurable: true });
const { showModal, close } = FakeElement.prototype;
FakeElement.prototype.showModal = function showOpen() { showModal.call(this); this.setAttribute('open', ''); };
FakeElement.prototype.close = function closeOpen() { this.removeAttribute('open'); close.call(this); };

const { placeFixed, fixedRoom, highlight, searchSection, searchResults, searchTitle } = await import('../web/ui.js');
const { el } = await import('../web/dom.js');
const i18n = await import('../web/i18n.js');
const english = JSON.parse(fs.readFileSync(new URL('../i18n/en.json', import.meta.url), 'utf8'));
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => english });
await i18n.loadLanguage('en', { remember: false });
const { attachments, photoViewer, isPhotoFile } = await import('../web/files.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const textOf = (parts) => parts.map((part) => (typeof part === 'string' ? part : `[${part.textContent}]`)).join('');

/* ------------------------------- placeFixed ------------------------------- */

test('placeFixed: inside a window of Cronum Work, measured from where its (0, 0) lands', () => {
  Object.assign(globalThis.window, { innerWidth: 1400, innerHeight: 900 });
  const body = el('div', { class: 'cw-win__body' });
  const root = el('div', { id: 'modal-root' });
  body.append(root);
  document.body.append(body);
  // The window from x 700 to 1300, y 100 to 700; fixed inside it, (0, 0) lands on its corner.
  body.getBoundingClientRect = () => ({ left: 700, top: 100, right: 1300, bottom: 700, width: 600, height: 600 });
  const pop = el('div', { class: 'qty-pop' });
  root.append(pop);
  pop.getBoundingClientRect = () => ({ left: 700, top: 100, right: 700, bottom: 100, width: 0, height: 0 });
  Object.defineProperty(pop, 'offsetWidth', { value: 240 });
  Object.defineProperty(pop, 'offsetHeight', { value: 100 });
  try {
    const room = fixedRoom(pop);
    assert.deepEqual(room.origin, { left: 700, top: 100 });
    assert.equal(room.frame.right, 1300, 'its room is the window');

    // A bubble near the window's end: the box ends 8 px inside it, 6 px under the bubble.
    const bubble = el('button');
    bubble.getBoundingClientRect = () => ({ left: 1200, right: 1240, top: 300, bottom: 324, width: 40, height: 24 });
    const at = placeFixed(pop, bubble);
    assert.deepEqual(at, { left: 1052, top: 330 });
    assert.equal(pop.style.left, '352px', 'written from the window\'s corner, not the screen\'s');
    assert.equal(pop.style.top, '230px');

    // Near the bottom it goes above; `above` prefers it, `center` centres it on the anchor.
    bubble.getBoundingClientRect = () => ({ left: 900, right: 940, top: 650, bottom: 674, width: 40, height: 24 });
    assert.equal(placeFixed(pop, bubble).top, 544, 'above, as it doesn\'t fit below');
    bubble.getBoundingClientRect = () => ({ left: 900, right: 940, top: 400, bottom: 424, width: 40, height: 24 });
    const up = placeFixed(pop, bubble, { above: true, center: true, gap: 10, width: 320 });
    assert.equal(up.top, 290);
    assert.equal(up.left, 760, 'centred on the anchor');
    assert.equal(pop.style.width, '320px');
  } finally {
    body.remove();
    globalThis.window = { innerWidth: 390, innerHeight: 800 };
  }
});

test('placeFixed: alone on a screen, its room is the screen, and a box wider than it narrows', () => {
  const box = el('div');
  document.body.append(box);
  Object.defineProperty(box, 'offsetWidth', { value: 500 });
  try {
    const at = placeFixed(box, null, { at: { x: 100, y: 50 } });
    assert.equal(box.style.width, '374px', 'the screen less its margins');
    assert.deepEqual(at, { left: 8, top: 50 });
  } finally {
    box.remove();
  }
});

/* --------------------------------- search --------------------------------- */

test('highlight: each word found, whatever its accents and case, as <mark> nodes and never HTML', () => {
  assert.equal(textOf(highlight('Comprar café en Mercadona', 'cafe merca')), 'Comprar [café] en [Merca]dona');
  assert.equal(textOf(highlight('Árbol', 'ARB')), '[Árb]ol');
  assert.equal(textOf(highlight('aaa', 'a aa')), '[aaa]', 'overlapping finds are one mark');
  assert.deepEqual(highlight('Nothing here', 'zzz'), ['Nothing here']);
  assert.deepEqual(highlight('Text', ''), ['Text']);
  const [mark] = highlight('<b>', '<b>');
  assert.equal(mark.tagName, 'MARK');
  assert.equal(mark.getAttribute('class'), 'kit-mark');
  assert.equal(mark.textContent, '<b>', 'written as text');
});

test('searchResults: each kind with its heading and count, and the kit\'s blank when nothing', () => {
  assert.equal(searchTitle(), 'Results');
  const found = searchResults({
    query: 'x',
    sections: [
      { title: 'Projects', rows: [el('a', { text: 'One' }), el('a', { text: 'Two' })] },
      { title: 'Tasks', rows: [] },
      searchSection('Steps', [el('a', { text: 'Three' })], { list: el('ul') }),
    ],
  });
  const sections = found.querySelectorAll('section');
  assert.equal(sections.length, 2, 'a kind with nothing found is left out');
  assert.equal(sections[0].querySelector('.kit-results__count').textContent, '2');
  assert.equal(sections[1].querySelector('ul').children.length, 1, 'the module\'s own list');

  const none = searchResults({ query: '  cafe ', sections: [{ title: 'Tasks', rows: [] }] });
  assert.equal(none.querySelector('strong').textContent, 'No results');
  assert.equal(none.querySelector('p').textContent, 'Nothing matches “cafe”.');
  assert.equal(none.querySelector('.kit-blank__icon').children.length, 1, 'the search\'s icon');
  const own = searchResults({ query: 'x', hint: 'Filters: tag:x' });
  assert.equal(own.querySelector('p').textContent, 'Filters: tag:x', 'a module\'s own words in its place');
});

/* --------------------------------- dates ---------------------------------- */

test('shortDate, timeText, shortStamp and timeAgo: one way in every module', () => {
  const year = new Date().getFullYear();
  assert.equal(i18n.shortDate(`${year}-03-14`), 'Mar 14', 'a day is the local day it names');
  assert.equal(i18n.shortDate(`${year + 1}-01-02`), `Jan 2, ${year + 1}`, 'with its year when not this one');
  assert.equal(i18n.shortDate(''), '');
  assert.equal(i18n.shortDate('not a date'), '');
  const nine = new Date(year, 2, 14, 9, 5);
  assert.equal(i18n.timeText(nine), '9:05 AM', 'the language\'s own short time');
  assert.equal(i18n.shortStamp(new Date()), i18n.timeText(new Date()), 'today: the time');
  assert.equal(i18n.shortStamp(nine), 'Mar 14');
  assert.equal(i18n.shortStamp(nine, { time: true }), 'Mar 14, 9:05 AM');
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
  assert.equal(i18n.timeAgo(daysAgo(0)), 'today');
  assert.equal(i18n.timeAgo(daysAgo(1)), 'yesterday');
  assert.equal(i18n.timeAgo(daysAgo(3)), '3 days ago');
  assert.equal(i18n.timeAgo(daysAgo(90)), '3 months ago');
  assert.equal(i18n.timeAgo(null), '');
});

/* --------------------------------- files ---------------------------------- */

const photo = { id: 1, name: 'IMG_1.jpg', mime: 'image/jpeg', size: 2048 };
const pdf = { id: 2, name: 'Invoice.pdf', mime: 'application/pdf', size: 4096 };
const fileUrl = (file, { download = false } = {}) => `/files/${file.id}${download ? '?download=1' : ''}`;
const press = (node) => Promise.all((node.listeners.click || []).map((fn) => fn({ currentTarget: node, target: node, stopPropagation() {} })));

test('attachments: «Files» with how many, a photo as a thumbnail and a PDF as a row with its size', () => {
  assert.equal(attachments({ files: [], editable: false, fileUrl }), null, 'nothing to show nor to do');
  const section = attachments({ files: [photo, pdf], editable: false, fileUrl });
  assert.equal(section.querySelector('.kit-files__title').textContent, 'Files2');
  assert.equal(section.querySelector('img').getAttribute('src'), '/files/1');
  assert.equal(section.querySelector('.kit-file__name').textContent, 'Invoice.pdf');
  assert.equal(section.querySelector('.kit-file__size').textContent, '4 kB');
  assert.equal(section.querySelectorAll('.kit-files__remove').length, 0, 'only to look at: nothing to take away');
  assert.equal(section.querySelectorAll('.kit-files__add').length, 0);
  assert.ok(isPhotoFile(photo) && !isPhotoFile(pdf));
});

test('attachments: taking one away sends it to the trash at once, with Undo', async () => {
  const calls = [];
  const section = attachments({
    files: [photo, pdf], editable: true, fileUrl, upload: async () => ({}),
    mayRemove: (file) => file.id === 2,
    remove: async (file) => { calls.push(['remove', file.id]); },
    restore: async (file) => { calls.push(['restore', file.id]); },
  });
  const removes = section.querySelectorAll('.kit-files__remove');
  assert.equal(removes.length, 1, 'only what this person may take away');
  await press(removes[0]);
  assert.deepEqual(calls, [['remove', 2]], 'no question first');
  const notice = document.body.querySelectorAll('.kit-toast').at(-1);
  assert.match(notice.textContent, /“Invoice.pdf” moved to the trash/);
  await press(notice.querySelector('button'));
  assert.deepEqual(calls.at(-1), ['restore', 2], 'Undo brings it back');
});

test('attachments: the room left is said before uploading, and the answers come once at the end', async () => {
  const sent = [];
  let told = null;
  const section = attachments({
    files: [photo], editable: true, fileUrl, max: 2,
    upload: async (blob, name) => { sent.push(name); return { name }; },
    onUploaded: (results) => { told = results; },
  });
  const input = section.querySelector('input');
  const fake = (name, type) => ({ name, type, size: 10 });
  input.files = [fake('a.pdf', 'application/pdf'), fake('b.pdf', 'application/pdf'), fake('c.txt', 'text/plain')];
  input.dispatch('change');
  await settle();
  await settle();
  assert.deepEqual(sent, ['a.pdf'], 'only what fits, and only photos and PDFs');
  assert.deepEqual(told, [{ name: 'a.pdf' }]);
  const notices = document.body.querySelectorAll('.kit-toast').map((n) => n.textContent).join(' | ');
  assert.match(notices, /Only photos and PDFs/);
  assert.match(notices, /Only 1 more fits/);

  const full = attachments({ files: [photo, pdf], editable: true, fileUrl, max: 2, upload: async () => ({}) });
  assert.equal(full.querySelectorAll('.kit-files__add').length, 0, 'full: no button');
  assert.match(full.textContent, /It holds 2 files at most/);
});

test('attachments: a file dropped on the detail or pasted into it is added; a section drawn again takes its place', async () => {
  const detail = el('div', { class: 'detail' });
  const sent = [];
  const draw = (tag) => attachments({
    files: [], editable: true, fileUrl, dropTarget: detail,
    upload: async (blob, name) => { sent.push(`${tag}:${name}`); return {}; },
  });
  draw('first');
  draw('second');
  const file = { name: 'scan.pdf', type: 'application/pdf', size: 10 };
  let prevented = false;
  const transfer = { types: ['Files'], files: [file] };
  for (const fn of detail.listeners.dragover) fn({ dataTransfer: transfer, preventDefault() { prevented = true; } });
  assert.ok(prevented, 'taken, so the browser doesn\'t open the photo');
  for (const fn of detail.listeners.drop) fn({ dataTransfer: transfer, preventDefault() {} });
  await settle();
  await settle();
  assert.deepEqual(sent, ['second:scan.pdf'], 'once, by the section drawn last');

  // Words pasted into a field are the field's.
  const field = el('textarea');
  let taken = false;
  for (const fn of detail.listeners.paste) {
    fn({ target: field, clipboardData: { files: [file], getData: () => 'some words' }, preventDefault() { taken = true; } });
  }
  assert.equal(taken, false);
  for (const fn of detail.listeners.paste) fn({ target: detail, clipboardData: { files: [file], getData: () => '' }, preventDefault() { taken = true; } });
  assert.ok(taken, 'a picture alone is a file');
  await settle();
  await settle();
  assert.equal(sent.length, 2);
});

test('photoViewer: a kit dialog in the top layer, with the arrows to the others and its download', async () => {
  const second = { id: 3, name: 'IMG_2.jpg', mime: 'image/jpeg', size: 1 };
  const { dialog, close: shut } = photoViewer({ photos: [photo, second], start: second, fileUrl });
  try {
    assert.equal(dialog.tagName, 'DIALOG');
    assert.ok(dialog.open, 'shown modal: over everything, in Cronum Work too');
    assert.equal(dialog.querySelector('img').src, '/files/3', 'the one tapped first');
    assert.equal(dialog.querySelector('.kit-viewer__counter').textContent, '2 of 2');
    assert.equal(dialog.querySelector('a').href, '/files/3?download=1');
    for (const fn of dialog.listeners.keydown) fn({ key: 'ArrowRight', target: dialog, preventDefault() {} });
    assert.equal(dialog.querySelector('img').src, '/files/1', 'and round again');
  } finally {
    shut();
    await settle();
  }
});
