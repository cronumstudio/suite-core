import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderMail, mailBrand, accountMail } from '../mail-layout.js';
import { createShareMail } from '../share-mail.js';
import { createTexts } from '../i18n.js';
import { resolveConfig } from '../config.js';

const work = mailBrand({
  name: 'Cronum Work', color: '#2438B8',
  mail: { icon: '/icons/apple-touch-180.png', colorOnDark: '#8C9BFF', signature: 'by Cronum Studio', about: { en: 'Tasks and notes in one app.', es: 'Tareas y notas en una sola app.' } },
}, 'https://work.example.com/');
const tasks = { name: 'Tasks', color: '#EF4B2A', icon: 'https://work.example.com/tasks/icons/apple-touch-180.png' };
const person = (lang) => ({ id: 2, email: 'ana@example.com', prefs: JSON.stringify({ lang }) });

function fakeMailer({ fail = false } = {}) {
  const sent = [];
  return { sent, send: async (message) => { if (fail) throw new Error('refused'); sent.push(message); } };
}

test('a brand from the app: its icon at its own address, its colours, its signature', () => {
  assert.equal(work.url, 'https://work.example.com/');
  assert.equal(work.icon, 'https://work.example.com/icons/apple-touch-180.png');
  assert.equal(work.colorOnDark, '#8C9BFF');
  assert.equal(mailBrand({ name: 'Notes', mail: { icon: null } }, 'https://n.example.com').icon, null);
});

test('the layout: escaped, only web links, no hidden text, and a plain part that says the same', () => {
  const { html, text } = renderMail({
    lang: 'en', brand: work, heading: 'Ana <b>invited</b> you',
    lead: 'First "line"\n\nSecond', button: { label: 'Open', href: 'https://work.example.com/tasks/' },
    card: { icon: 'javascript:alert(1)', title: 'A & B', meta: 'Tasks list' }, footer: 'Why it came',
  });
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<html lang="en"/);
  assert.match(html, /Ana &lt;b&gt;invited&lt;\/b&gt; you<span style="color:#FFC21A">\.<\/span>/);
  assert.match(html, /A &amp; B/);
  assert.doesNotMatch(html, /javascript:/);
  assert.doesNotMatch(html, /display:none/, 'no hidden preheader: filters frown on hidden text');
  assert.match(html, /href="https:\/\/work\.example\.com\/tasks\/"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /<b style="font-weight:700">cronum<\/b> <span style="font-weight:500">work<\/span>/);
  assert.match(html, /by Cronum Studio/);
  assert.equal(text.split('\n\n')[0], 'Ana <b>invited</b> you.');
  assert.match(text, /Open: https:\/\/work\.example\.com\/tasks\//);
  assert.match(text, /Cronum Work · by Cronum Studio$/);
  // A link that isn't the web's gives no button at all.
  assert.doesNotMatch(renderMail({ lang: 'en', brand: work, heading: 'Hi', button: { label: 'Go', href: 'ftp://x' } }).html, /ftp:/);
  // A heading with its own sign keeps it, without the yolk dot.
  assert.match(renderMail({ lang: 'en', brand: work, heading: 'Ready?' }).html, />Ready\?<\/h1>/);
});

test('an account message: its link becomes the button, the rest stays as written', () => {
  const link = 'https://work.example.com/?verify=ev_1';
  const html = accountMail({
    lang: 'en', brand: work, subject: 'Confirm your email for Cronum Work', link, button: 'Confirm my email',
    body: `Hello Ana,\n\nTo confirm, open this link:\n\n${link}\n\nIt works for 48 hours.\n\nCronum Work`,
  });
  assert.match(html, /Confirm my email/);
  assert.equal(html.split(link).length - 1, 2, 'the link only in the button (and its Outlook twin)');
  assert.match(html, /It works for 48 hours\./);
  assert.match(html, /Hello Ana,/);
});

test('the share email: in the language of whoever gets it, the module over the heading, the button to it', async () => {
  const mailer = fakeMailer();
  const send = createShareMail({ mailer, texts: createTexts(), brand: work, module: tasks, baseUrl: 'https://work.example.com/tasks' });
  assert.equal(await send({ to: person('es'), actor: 'Lucía García', kind: 'list', name: 'Lanzamiento', icon: '🚀', permission: 'edit' }), true);
  const [message] = mailer.sent;
  assert.equal(message.to, 'ana@example.com');
  assert.equal(message.subject, 'Lucía García te ha invitado a la lista «Lanzamiento»');
  assert.match(message.html, /<html lang="es"/);
  assert.match(message.html, /Invitación · Tasks/);
  assert.match(message.html, /color:#EF4B2A">Invitación/);
  assert.match(message.html, /🚀 Lanzamiento/);
  assert.match(message.html, /Lista de Tasks · puedes ver y editar/);
  assert.match(message.html, /href="https:\/\/work\.example\.com\/tasks\/"/);
  assert.match(message.html, /¿Qué es Cronum Work\?/);
  assert.match(message.html, /Tareas y notas en una sola app\./);
  assert.match(message.text, /Ver y aceptar: https:\/\/work\.example\.com\/tasks\//);
  assert.match(message.text, /para que veas y cambies sus tareas/);
});

test('the share email: every kind, to read or to edit, and a project with its role', () => {
  const send = createShareMail({ mailer: fakeMailer(), texts: createTexts(), brand: work, module: tasks, baseUrl: 'https://w.example.com/notes' });
  for (const lang of ['en', 'es', 'fr', 'de', 'it']) {
    for (const kind of ['list', 'notebook', 'group', 'note', 'project', 'plan']) {
      for (const permission of ['view', 'edit']) {
        const { subject, html, text } = send.compose({ to: person(lang), actor: 'Ana', kind, name: 'Plan', permission, role: 'Member' });
        for (const part of [subject, html, text]) assert.doesNotMatch(part, /mail\.share|\{\w+\}/, `${lang} ${kind}: ${part.slice(0, 80)}`);
        assert.match(subject, /Ana/);
        assert.match(subject, /Plan/);
      }
    }
  }
  const view = send.compose({ to: person('en'), actor: 'Ana', kind: 'notebook', name: 'Plan', permission: 'view' });
  assert.match(view.text, /so you can read its notes\./);
  assert.match(view.text, /view only/);
  const project = send.compose({ to: person('en'), actor: 'Ana', kind: 'project', name: 'Plan', role: 'Member' });
  assert.match(project.text, /Tasks project · Member/);
  // A project of Next (its kind is `plan`, as `project` is a place in a team of Projects) is followed, to read or to log.
  const plan = send.compose({ to: person('es'), actor: 'Ana', kind: 'plan', name: 'Lanzamiento', icon: '🚀', permission: 'view' });
  assert.equal(plan.subject, 'Ana te ha invitado al proyecto «Lanzamiento»');
  assert.match(plan.text, /para que sigas su avance: cada paso dado y el siguiente./);
  assert.match(plan.text, /Proyecto de Tasks · solo lectura/);
  assert.match(send.compose({ to: person('en'), actor: 'Ana', kind: 'plan', name: 'Launch' }).text, /follow its progress and log its steps/);
  assert.match(send.compose({ to: person('en'), actor: 'Ana', kind: 'note', name: '' }).subject, /“Untitled”/);
  assert.throws(() => send.compose({ to: person('en'), actor: 'Ana', kind: 'folder', name: 'x' }), /no kind/);
});

test('the share email: nobody to send it to, and a refusal said in the log', async () => {
  const lines = [];
  const send = createShareMail({ mailer: fakeMailer({ fail: true }), texts: createTexts(), brand: work, baseUrl: 'https://w.example.com', log: (l) => lines.push(l) });
  assert.equal(await send({ to: { id: 3, email: null }, actor: 'Ana', kind: 'list', name: 'x' }), false);
  assert.equal(await send({ to: person('en'), actor: 'Ana', kind: 'list', name: 'x' }), false);
  assert.match(lines[0], /not sent \(a list offered\): refused/);
  // On its own, the product is the module: the line over the heading names it.
  const own = createShareMail({ mailer: fakeMailer(), texts: createTexts(), brand: work, baseUrl: 'https://w.example.com' });
  assert.match(own.compose({ to: person('en'), actor: 'Ana', kind: 'list', name: 'x' }).html, /Invitation · Cronum Work/);
});

test('app.mail in suite.config.js: a PNG of its own, colours, a short signature, what it is by language', () => {
  const base = { app: { id: 'work', name: 'Cronum Work' } };
  assert.deepEqual(resolveConfig(base, {}).app.mail, { icon: '/icons/apple-touch-180.png', colorOnDark: null, signature: null, about: null });
  const bad = resolveConfig({ app: { ...base.app, mail: { icon: '/icons/w.svg', colorOnDark: 'blue', signature: 'x'.repeat(81), about: { es: 'Hola' } } } }, {});
  for (const what of ['app.mail.icon', 'app.mail.colorOnDark', 'app.mail.signature', 'app.mail.about']) {
    assert.ok(bad.errors.some((e) => e.startsWith(what)), what);
  }
  const good = resolveConfig({ app: { ...base.app, mail: { icon: null, colorOnDark: '#8C9BFF', signature: 'by Cronum Studio', about: { en: 'One app.', it: 'Una app.' } } } }, {});
  assert.ok(!good.errors.some((e) => e.startsWith('app.mail')), good.errors.join('; '));
});
