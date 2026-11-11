/**
 * The kit's dialogs and menus (web/ui.js), without a browser: the form dialog every module can
 * use (its error inside, one send at a time, Ctrl/Cmd+Enter, actions that change), one action at a
 * time in every dialog, Escape for the top dialog only (and for a menu open in it before the
 * dialog), and what the modules need to drop their own copies: a width, a place to hang, a body
 * and foot of their own, a confirmation's second line, a menu at a pointer's place with emoji,
 * one whose items may be left out, and the «…» that opens one.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDom, FakeElement } from './fake-dom.js';

const document = installFakeDom();
globalThis.window = { innerWidth: 390, innerHeight: 800 };
// menu() measures where it goes; nothing has a size here.
FakeElement.prototype.getBoundingClientRect = () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 });
for (const name of ['offsetWidth', 'offsetHeight']) Object.defineProperty(FakeElement.prototype, name, { get: () => 0, configurable: true });
// An open dialog carries its attribute, as in a browser (a menu looks for `dialog[open]`).
const { showModal, close } = FakeElement.prototype;
FakeElement.prototype.showModal = function showOpen() { showModal.call(this); this.setAttribute('open', ''); };
FakeElement.prototype.close = function closeOpen() { this.removeAttribute('open'); close.call(this); };

const { openDialog, formDialog, confirmDialog, deleteDialog, undoToast, QUESTION_WIDTH, menu, closeMenu, moreButton } = await import('../web/ui.js');
const { el } = await import('../web/dom.js');

const buttonsOf = (node) => node.find('button').filter((b) => (b.getAttribute('class') || '').includes('kit-btn'));
const press = (button) => Promise.all((button.listeners.click || []).map((fn) => fn({ currentTarget: button, target: button })));
const later = () => {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
};
const event = (props = {}) => {
  const ev = { defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; }, ...props };
  return ev;
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------- form dialog ------------------------------ */

test('formDialog: what onSubmit throws shows inside the dialog, which stays open to be corrected', async () => {
  let tries = 0;
  const { dialog, form } = formDialog({
    title: 'New project', subtitle: 'In Next',
    content: el('input', { name: 'name' }),
    actions: [{ label: 'Cancel' }, { label: 'Create', primary: true, submit: true }],
    errorText: (err) => `Could not: ${err.code}`,
    async onSubmit() {
      tries += 1;
      if (tries === 1) throw { code: 'name_taken' };
    },
  });
  assert.equal(dialog.open, true);
  assert.equal(dialog.find('h2')[0].textContent, 'New project');
  assert.equal(dialog.querySelector('.kit-dialog__subtitle').textContent, 'In Next');
  const error = dialog.querySelector('.kit-dialog__error');
  assert.equal(error.hasAttribute('hidden'), true, 'no error before a try');

  form.dispatch('submit', event());
  await settle();
  assert.equal(dialog.open, true, 'a refusal keeps it open');
  assert.equal(error.textContent, 'Could not: name_taken');
  assert.equal(error.hasAttribute('hidden'), false);
  assert.equal(error.getAttribute('role'), 'alert');

  form.dispatch('submit', event());
  await settle();
  assert.equal(tries, 2);
  assert.equal(dialog.open, false, 'a success closes it');
  assert.ok(!document.body.childNodes.includes(dialog), 'and takes it away');
});

test('formDialog: one send at a time; every button waits with it (a double click creates one project)', async () => {
  const wait = later();
  let sent = 0;
  const { dialog, form } = formDialog({
    title: 'New project', content: el('p', { text: 'name' }),
    actions: [{ label: 'Cancel' }, { label: 'Delete', danger: true, onClick: () => { sent += 100; } }, { label: 'Create', primary: true, submit: true }],
    onSubmit: async () => { sent += 1; await wait.promise; },
  });
  const buttons = buttonsOf(dialog.querySelector('.kit-dialog__footer'));
  assert.deepEqual(buttons.map((b) => b.getAttribute('type')), ['button', 'button', 'submit']);

  form.dispatch('submit', event());
  form.dispatch('submit', event());
  form.dispatch('keydown', event({ key: 'Enter', ctrlKey: true }));
  assert.equal(sent, 1, 'the second click, Enter and Ctrl+Enter wait for the first');
  assert.ok(buttons.every((b) => b.disabled), 'every button of the footer is disabled while it waits');
  await press(buttons[1]);
  assert.equal(sent, 1, 'not even another action runs meanwhile');

  wait.release();
  await settle();
  assert.equal(dialog.open, false);
  assert.ok(buttons.every((b) => !b.disabled), 'and back as they were');
});

test('formDialog: Ctrl/Cmd+Enter sends from a long text; false keeps it open; setActions changes the footer', async () => {
  const seen = [];
  const { dialog, form, setActions } = formDialog({
    title: 'Step', content: el('textarea'),
    onSubmit: (f) => { seen.push(f === form); return false; },
  });
  const footer = dialog.querySelector('.kit-dialog__footer');
  assert.equal(footer.hasAttribute('hidden'), true, 'no actions, no footer');

  const enter = event({ key: 'Enter' });
  form.dispatch('keydown', enter);
  assert.equal(enter.defaultPrevented, false, 'a plain Enter is a new line in a text');
  const meta = event({ key: 'Enter', metaKey: true });
  form.dispatch('keydown', meta);
  await settle();
  assert.equal(meta.defaultPrevented, true);
  assert.deepEqual(seen, [true], 'onSubmit gets the form');
  assert.equal(dialog.open, true, 'false keeps it open');

  setActions([{ label: 'Merge', primary: true, submit: true }]);
  assert.equal(footer.hasAttribute('hidden'), false);
  assert.deepEqual(buttonsOf(footer).map((b) => b.textContent), ['Merge']);
  setActions([]);
  assert.equal(footer.hasAttribute('hidden'), true);
  // An action with neither submit nor onClick only closes: Cancel.
  setActions([{ label: 'Cancel' }]);
  await press(buttonsOf(footer)[0]);
  assert.equal(dialog.open, false);
});

test('formDialog: header, tools and bar; an onClick that throws shows its error too', async () => {
  const tools = el('button', { type: 'button', text: '✎' });
  const { dialog } = formDialog({
    header: el('div', { class: 'where', text: 'Cronum · main' }), tools, bar: el('nav', { text: 'tabs' }),
    extra: el('a', { text: 'Delete' }),
    actions: [{ label: 'Archive', onClick: () => { throw new Error('nope'); } }],
    errorText: (err) => err.message,
  });
  const [header] = dialog.find('header');
  assert.equal(header.querySelector('.where').textContent, 'Cronum · main');
  assert.equal(header.find('h2').length, 0, 'a header of its own replaces the title');
  assert.ok(header.querySelector('.kit-dialog__tools').contains(tools), 'tools before the ×');
  const nav = dialog.find('nav')[0];
  assert.ok(nav && !dialog.querySelector('.kit-dialog__form').contains(nav), 'the bar sits out of the form and its scroll');
  assert.equal(dialog.querySelector('.kit-dialog__extra').textContent, 'Delete');
  await press(buttonsOf(dialog.querySelector('.kit-dialog__footer'))[0]);
  assert.equal(dialog.open, true);
  assert.equal(dialog.querySelector('.kit-dialog__error').textContent, 'nope');
  dialog.close();
});

/* ------------------------------ every dialog ------------------------------ */

test('openDialog: while one action waits every action is disabled, so Save and Delete never run at once', async () => {
  const wait = later();
  const ran = [];
  const { dialog } = openDialog({
    title: 'Edit project', content: el('p', { text: 'Cronum' }),
    actions: [
      { label: 'Cancel' },
      { label: 'Delete', danger: true, onClick: () => { ran.push('delete'); } },
      { label: 'Save', primary: true, onClick: async () => { ran.push('save'); await wait.promise; } },
    ],
  });
  const [cancel, del, save] = buttonsOf(dialog);
  const saving = press(save);
  press(save);
  await press(del);
  assert.deepEqual(ran, ['save'], 'neither a second Save nor a Delete while it saves');
  assert.ok([cancel, del, save].every((b) => b.disabled));
  wait.release();
  await saving;
  assert.equal(dialog.open, false);
});

test('Escape closes only the top dialog, and a menu open in it before the dialog', async () => {
  const under = openDialog({ title: 'List', content: el('p', { text: 'editor' }) });
  const top = openDialog({ title: 'Sure?', content: el('p', { text: 'confirm' }) });

  const lower = event();
  under.dialog.dispatch('cancel', lower);
  assert.equal(lower.defaultPrevented, true, 'the dialog underneath keeps still');
  const upper = event();
  top.dialog.dispatch('cancel', upper);
  assert.equal(upper.defaultPrevented, false, 'the top one closes, as the browser does');
  top.close();
  assert.equal(under.dialog.open, true, 'and the one under it is still open, with its draft');

  // A menu opened from inside the dialog: Escape is the menu's, and the dialog stays.
  const anchor = el('button', { type: 'button' });
  under.dialog.append(anchor);
  const node = menu(anchor, [{ label: 'Rename' }]);
  assert.ok(under.dialog.contains(node), 'a menu from a dialog hangs inside it');
  const key = event({ key: 'Escape' });
  for (const fn of [...document.listeners.keydown]) fn(key);
  assert.equal(key.defaultPrevented, true, 'the menu keeps its Escape from the dialog');
  assert.ok(!under.dialog.contains(node), 'and closes');

  menu(anchor, [{ label: 'Rename' }]);
  const cancel = event();
  under.dialog.dispatch('cancel', cancel);
  assert.equal(cancel.defaultPrevented, true, 'a cancel that reaches the dialog closes the menu first');
  assert.equal(document.listeners.keydown.length, 0, 'the menu took its listener with it');
  under.close();
  await settle();
});

test('the backdrop: a tap on it closes; a press that began inside and ended on it does not', () => {
  const { dialog } = openDialog({ title: 'Rename', content: el('input') });
  const input = dialog.find('input')[0];
  dialog.dispatch('pointerdown', { target: input });
  dialog.dispatch('click', { target: dialog });
  assert.equal(dialog.open, true, 'selecting a field\'s text past the edge is not a tap outside');
  dialog.dispatch('pointerdown', { target: dialog });
  dialog.dispatch('click', { target: dialog });
  assert.equal(dialog.open, false);
});

test('what is written in a form stays: a tap outside only puts the keyboard away, Escape asks (audit of 6/11, ux-acciones-5)', async () => {
  const { dialog } = formDialog({ title: 'Log progress', content: [el('input', { name: 'done' }), el('textarea', { name: 'next' })] });
  const [input] = dialog.find('input');
  const [area] = dialog.find('textarea');
  // Nothing written yet: a tap outside closes, as always.
  dialog.dispatch('focusin', { target: input });
  dialog.dispatch('pointerdown', { target: dialog });
  dialog.dispatch('click', { target: dialog });
  assert.equal(dialog.open, false, 'untouched, it closes');

  const again = formDialog({ title: 'Log progress', content: [el('input', { name: 'done' }), el('textarea', { name: 'next' })] }).dialog;
  const [field] = again.find('textarea');
  again.dispatch('focusin', { target: field });
  field.value = 'Fixed the queue';
  again.dispatch('pointerdown', { target: again });
  again.dispatch('click', { target: again });
  assert.equal(again.open, true, 'a tap outside keeps it');

  const esc = event();
  again.dispatch('cancel', esc);
  assert.equal(esc.defaultPrevented, true, "Escape doesn't throw it away");
  await settle();
  const asking = document.body.find('dialog').filter((d) => d.open && d !== again).at(-1);
  assert.ok(asking, 'it asks');
  const [keep, discard] = buttonsOf(asking);
  await press(keep);
  await settle();
  assert.equal(again.open, true, 'kept writing');

  again.dispatch('cancel', event());
  await settle();
  const second = document.body.find('dialog').filter((d) => d.open && d !== again).at(-1);
  await press(buttonsOf(second)[1]);
  await settle();
  assert.equal(again.open, false, 'thrown away only with a yes');

  // Written and put back is nothing written; a form whose fields save themselves passes false.
  const back = formDialog({ title: 'Rename', content: el('input', { value: 'Ana' }) }).dialog;
  const [name] = back.find('input');
  back.dispatch('focusin', { target: name });
  name.value = 'Anab';
  name.value = 'Ana';
  back.dispatch('pointerdown', { target: back });
  back.dispatch('click', { target: back });
  assert.equal(back.open, false);
  const own = formDialog({ title: 'Settings', keepTyped: false, content: el('input') }).dialog;
  const [mine] = own.find('input');
  own.dispatch('focusin', { target: mine });
  mine.value = 'x';
  own.dispatch('pointerdown', { target: own });
  own.dispatch('click', { target: own });
  assert.equal(own.open, false);
  // openDialog keeps its old way unless asked.
  const plain = openDialog({ title: 'Search', content: el('input') }).dialog;
  const [query] = plain.find('input');
  plain.dispatch('focusin', { target: query });
  query.value = 'pan';
  plain.dispatch('pointerdown', { target: plain });
  plain.dispatch('click', { target: plain });
  assert.equal(plain.open, false);
});

test('what the modules need: a width, a place to hang, a body and a foot of their own', () => {
  const root = el('div', { id: 'modal-root' });
  document.body.append(root);
  const body = el('div', { class: 'modal-body' }, el('p', { text: 'Trash' }));
  const footer = el('div', { class: 'modal-foot' });
  let closed = 0;
  const { dialog, close } = openDialog({ title: 'Trash', body, footer, width: '520px', parent: root, className: 'tasks', onClose: () => { closed += 1; } });
  assert.equal(dialog.parentNode, root, 'in the module\'s own place');
  assert.equal(dialog.getAttribute('style'), '--kit-dialog-width: 520px', 'a variable: a phone\'s sheet still takes the whole width');
  assert.match(dialog.className, /\bkit-dialog\b.*\btasks\b/);
  assert.equal(body.parentNode, dialog);
  assert.equal(body.className, 'modal-body kit-dialog__body', 'its own classes kept');
  assert.equal(footer.className, 'modal-foot kit-dialog__footer');
  // A foot the module fills after opening (its own buttons) is the dialog's foot.
  footer.append(el('button', { class: 'btn', text: 'Empty' }));
  assert.equal(dialog.querySelector('.kit-dialog__footer').textContent, 'Empty');
  close();
  assert.equal(closed, 1);
  assert.equal(root.children.length, 0);
  root.remove();
});

test('confirmDialog: its second line, its labels, and the answer once it is closed', async () => {
  const asked = confirmDialog('Delete the list?', { title: 'Confirm', confirm: 'Delete', cancel: 'Keep', detail: 'Its tasks go to the trash.', width: '400px', danger: false });
  const dialog = document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open).at(-1);
  assert.deepEqual(dialog.find('p').map((p) => p.textContent), ['Delete the list?', 'Its tasks go to the trash.']);
  const [keep, yes] = buttonsOf(dialog);
  assert.equal(keep.textContent, 'Keep');
  assert.match(yes.className, /kit-btn--primary/, 'not dangerous: the primary colour');
  await press(yes);
  assert.equal(await asked, true);

  const second = confirmDialog('Leave?');
  const again = document.body.all().find((node) => node.tagName === 'DIALOG' && node.open);
  again.dispatch('pointerdown', { target: again });
  again.dispatch('click', { target: again });
  assert.equal(await second, false, 'closed any other way is a no');
});

test('deleteDialog and undoToast: the question with its name and a red button, a question\'s width, the notice with Undo', async () => {
  const asked = deleteDialog('Kitchen', { detail: 'Its tasks go too.' });
  const dialog = document.body.all().filter((node) => node.tagName === 'DIALOG' && node.open).at(-1);
  assert.equal(dialog.getAttribute('aria-label'), 'kit.deleteAsk', 'the title asks, naming it (kit.deleteAsk)');
  assert.equal(dialog.getAttribute('style'), `--kit-dialog-width: ${QUESTION_WIDTH}`, 'narrower than a form');
  assert.deepEqual(dialog.find('p').map((p) => p.textContent), ['Its tasks go too.'], 'no empty line where the text would be');
  const [, yes] = buttonsOf(dialog);
  assert.match(yes.className, /kit-btn--danger/, 'red');
  assert.equal(yes.textContent, 'kit.delete');
  await press(yes);
  assert.equal(await asked, true);

  const undone = [];
  undoToast('Moved to the trash', () => undone.push(true));
  const note = document.body.all().filter((node) => (node.getAttribute?.('class') || '').split(/\s+/).includes('kit-toast')).at(-1);
  const undo = note.find('button')[0];
  assert.equal(undo.textContent, 'kit.undo');
  await press(undo);
  assert.deepEqual(undone, [true]);
});

/* ---------------------------------- menus --------------------------------- */

test('menu: at a pointer\'s place, in a module\'s own place, with emoji in place of icons', async () => {
  const root = el('div');
  document.body.append(root);
  const picked = [];
  const node = menu(null, [
    { glyph: '📁', label: 'Home', onClick: () => picked.push('home') },
    'separator',
    { glyph: '✓', label: 'Shared with me', current: true, onClick: () => picked.push('shared') },
  ], { at: { x: 120, y: 300 }, parent: root });
  assert.equal(node.parentNode, root);
  assert.equal(node.style.left, '120px');
  assert.equal(node.style.top, '300px');
  assert.deepEqual(node.querySelectorAll('.kit-menu__glyph').map((g) => g.textContent), ['📁', '✓']);
  assert.equal(node.querySelectorAll('[role="menuitem"]')[1].getAttribute('aria-current'), 'true');
  node.querySelectorAll('[role="menuitem"]')[0].click();
  assert.deepEqual(picked, ['home']);
  assert.equal(root.children.length, 0, 'a choice closes it');
  closeMenu();
  root.remove();
  await settle();
});

test('menu: what is left out (`cond ? item : null`) leaves no gap, nor a separator with nothing to separate', async () => {
  const node = menu(null, [
    null, 'separator', { label: 'Rename' }, false, 'separator', undefined, 'separator',
    { label: 'Share' }, 'separator', null,
  ]);
  assert.deepEqual(node.children.map((child) => child.getAttribute('role')), ['menuitem', 'separator', 'menuitem']);
  assert.deepEqual(node.querySelectorAll('[role="menuitem"]').map((item) => item.textContent), ['Rename', 'Share']);
  closeMenu();
  assert.equal(menu(null, [null, 'separator']).children.length, 0, 'nothing at all');
  closeMenu();
  await settle();
});

test('moreButton: «…» with its name, a menu of what is possible when it opens, closed by a second press', async () => {
  let shared = false;
  const button = moreButton(() => [
    { label: 'Rename', onClick: () => {} },
    shared ? { label: 'Stop sharing', onClick: () => {} } : null,
    'separator',
    { label: 'Delete', danger: true, onClick: () => {} },
  ]);
  document.body.append(button);
  assert.equal(button.getAttribute('class'), 'kit-icon-btn');
  assert.equal(button.getAttribute('aria-label'), 'kit.more', '«Más opciones», the kit\'s');
  assert.equal(button.getAttribute('title'), 'kit.more');
  assert.equal(button.getAttribute('aria-haspopup'), 'menu');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.ok(button.querySelector('svg'), 'the kit\'s «…» icon');

  let stopped = 0;
  const pressMore = () => { for (const fn of button.listeners.click) fn({ currentTarget: button, stopPropagation: () => { stopped += 1; } }); };
  const labels = () => document.body.all().find((node) => node.getAttribute('role') === 'menu')
    ?.querySelectorAll('[role="menuitem"]').map((item) => item.textContent);
  pressMore();
  assert.deepEqual(labels(), ['Rename', 'Delete']);
  assert.equal(button.getAttribute('aria-expanded'), 'true');
  pressMore();
  assert.equal(labels(), undefined, 'a second press closes it');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  shared = true;
  pressMore();
  assert.deepEqual(labels(), ['Rename', 'Stop sharing', 'Delete'], 'asked again each time it opens');
  assert.equal(stopped, 3, 'what it sits in doesn\'t take the press');
  closeMenu();
  button.remove();

  const named = moreButton([{ label: 'Export' }], { label: 'List options' });
  assert.equal(named.getAttribute('aria-label'), 'List options');
  for (const fn of named.listeners.click) fn({});
  assert.deepEqual(labels(), ['Export'], 'a list of items as it is, and an event without a way to stop it');
  closeMenu();
  await settle();
});

test('menu: in a window of Cronum Work, inside that window, which cuts off whatever leaves it', async () => {
  // A window of the desk from x 400 to 1000 and y 100 to 700, on a wider screen; the menu 200 tall.
  const saved = { ...globalThis.window };
  Object.assign(globalThis.window, { innerWidth: 1400, innerHeight: 900 });
  Object.defineProperty(FakeElement.prototype, 'offsetHeight', { get: () => 200, configurable: true });
  const body = el('div', { class: 'cw-win__body' });
  const root = el('div', { id: 'modal-root' });
  body.append(root);
  document.body.append(body);
  body.getBoundingClientRect = () => ({ left: 400, top: 100, right: 1000, bottom: 700, width: 600, height: 600 });
  try {
    // A tap near the window's end and bottom: the menu goes left and up, not under the next window.
    const node = menu(null, [{ label: 'Bug' }], { at: { x: 950, y: 650 }, parent: root });
    assert.equal(node.style.left, '772px', 'its end 8 px inside the window\'s end');
    assert.equal(node.style.top, '450px', 'above the tap, as it doesn\'t fit below in the window');
    assert.equal(node.style.maxHeight, undefined, 'it fits: no scroll');

    // A window shorter than the menu: it scrolls inside the window's height.
    body.getBoundingClientRect = () => ({ left: 400, top: 100, right: 1000, bottom: 250, width: 600, height: 150 });
    const short = menu(null, [{ label: 'Bug' }], { at: { x: 500, y: 200 }, parent: root });
    assert.equal(short.style.maxHeight, '134px');
    assert.equal(short.style.overflowY, 'auto');
  } finally {
    closeMenu();
    body.remove();
    Object.defineProperty(FakeElement.prototype, 'offsetHeight', { get: () => 0, configurable: true });
    globalThis.window = saved;
    await settle();
  }
});
