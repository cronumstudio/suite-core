/**
 * Outgoing mail: messages built safely, the log provider, and the SMTP client
 * against a fake server on localhost.
 *
 *   npm test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import {
  buildMessage, parseAddress, createMailer, mailConfigErrors, mailConfigFromEnv, sendSmtp, checkSmtp, MailError,
} from '../mail.js';

test('addresses and messages: encoded where needed, never broken into', () => {
  assert.deepEqual(parseAddress('Next <next@example.com>'), { name: 'Next', address: 'next@example.com' });
  assert.deepEqual(parseAddress('ana@example.com'), { name: '', address: 'ana@example.com' });
  assert.equal(parseAddress('not an address'), null);
  assert.equal(parseAddress('ana@example.com\r\nBcc: someone@evil.example'), null);

  const message = buildMessage({
    from: 'Próximo <next@example.com>', to: 'ana@example.com', subject: 'Contraseña\r\nBcc: someone@evil.example',
    text: 'Hola, Ana.\n'.repeat(20), domain: 'example.com',
  });
  const [head, body] = message.split('\r\n\r\n');
  assert.match(head, /^From: =\?UTF-8\?B\?[\w+/=]+\?= <next@example\.com>$/m);
  assert.match(head, /^Subject: =\?UTF-8\?B\?[\w+/=]+\?=$/m);
  assert.doesNotMatch(head, /^Bcc:/m, 'no header can be slipped in');
  assert.match(head, /^Message-ID: <[\w-]+@example\.com>$/m);
  assert.ok(body.split('\r\n').every((line) => line.length <= 76), 'base64 in lines of 76');
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Hola, Ana.\n'.repeat(20));

  const both = buildMessage({ from: 'a@example.com', to: 'b@example.com', subject: 'Hi', text: 'Plain', html: '<p>Rich</p>' });
  assert.match(both, /Content-Type: multipart\/alternative; boundary="(b_[0-9a-f]+)"/);
  assert.throws(() => buildMessage({ from: 'nobody', to: 'b@example.com', subject: 'x', text: 'y' }), MailError);
});

test('the configuration: log by default; SMTP needs a server and a sender', () => {
  assert.equal(mailConfigFromEnv({}).provider, 'log');
  assert.deepEqual(mailConfigErrors(mailConfigFromEnv({})), []);
  const smtp = mailConfigFromEnv({ MAIL_PROVIDER: 'smtp', MAIL_USER: 'next' });
  assert.deepEqual(mailConfigErrors(smtp), [
    'MAIL_PROVIDER=smtp needs MAIL_HOST',
    'MAIL_PROVIDER=smtp needs MAIL_FROM, like "Next <next@example.com>"',
    'MAIL_USER and MAIL_PASSWORD go together',
  ]);
  assert.equal(mailConfigFromEnv({ MAIL_PORT: '465' }).secure, 'tls');
  assert.equal(mailConfigFromEnv({}).secure, 'starttls');
  assert.deepEqual(mailConfigErrors({ provider: 'carrier-pigeon' }), ['MAIL_PROVIDER "carrier-pigeon": use smtp or log']);
});

test('the log provider writes the message where whoever runs the install can read it', async () => {
  const lines = [];
  const mailer = createMailer(mailConfigFromEnv({}), { log: (line) => lines.push(line) });
  await mailer.send({ to: 'ana@example.com', subject: 'A link', text: 'Open https://app.example/?reset=pr_x' });
  assert.match(lines[0], /^\[mail\] to ana@example\.com: A link\nOpen https:\/\/app\.example\/\?reset=pr_x$/);
  await assert.rejects(mailer.send({ to: 'nobody', subject: 'x', text: 'y' }), MailError);
});

/** A fake SMTP server: what it offers, what it refuses, and what it received. */
async function fakeSmtp(t, { offer = ['AUTH PLAIN LOGIN'], refuseRcpt = false } = {}) {
  const received = [];
  const server = net.createServer((socket) => {
    const session = { lines: [], data: false, auth: null };
    const say = (line) => socket.write(`${line}\r\n`);
    say('220 fake.example ESMTP');
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (session.data) {
          if (line === '.') {
            session.data = false;
            received.push({ ...session, message: session.lines.join('\r\n') });
            say('250 2.0.0 queued as F4K3');
          } else {
            session.lines.push(line);
          }
          continue;
        }
        if (session.auth === 'login-user') { session.user = Buffer.from(line, 'base64').toString(); session.auth = 'login-pass'; say('334 UGFzc3dvcmQ6'); continue; }
        if (session.auth === 'login-pass') { session.password = Buffer.from(line, 'base64').toString(); session.auth = 'done'; say('235 2.7.0 Accepted'); continue; }
        const [verb] = line.split(' ');
        if (verb === 'EHLO') { session.helo = line.slice(5); say('250-fake.example'); offer.forEach((o, i) => say(`250${i === offer.length - 1 ? ' ' : '-'}${o}`)); if (!offer.length) say('250 OK'); }
        else if (line.startsWith('AUTH PLAIN ')) {
          const [, user, password] = Buffer.from(line.slice(11), 'base64').toString().split('\0');
          Object.assign(session, { user, password });
          say(password === 'right' ? '235 2.7.0 Accepted' : '535 5.7.8 Bad credentials');
        } else if (line === 'AUTH LOGIN') { session.auth = 'login-user'; say('334 VXNlcm5hbWU6'); }
        else if (verb === 'MAIL') { session.from = line; say('250 OK'); }
        else if (verb === 'RCPT') { session.to = line; say(refuseRcpt ? '550 5.1.1 No such user' : '250 OK'); }
        else if (verb === 'DATA') { session.data = true; say('354 Go ahead'); }
        else if (verb === 'QUIT') { say('221 Bye'); socket.end(); }
        else say('502 Not implemented');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { port: server.address().port, received };
}

test('SMTP: signing in, sending, and dots at the start of a line', async (t) => {
  const { port, received } = await fakeSmtp(t);
  const config = { provider: 'smtp', host: '127.0.0.1', port, secure: 'none', user: 'next', password: 'right', from: 'Next <next@example.com>' };
  const mailer = createMailer(config);
  const sent = await mailer.send({ to: 'ana@example.com', subject: 'Hola', text: 'Hi' });
  assert.match(sent.response, /queued as F4K3/);
  assert.equal(received[0].user, 'next');
  assert.equal(received[0].from, 'MAIL FROM:<next@example.com>');
  assert.equal(received[0].to, 'RCPT TO:<ana@example.com>');
  assert.equal(received[0].helo, 'example.com');
  assert.match(received[0].message, /^From: Next <next@example\.com>/m);

  await sendSmtp(config, { from: config.from, to: 'ana@example.com', message: 'Subject: x\r\n\r\n.starts with a dot\r\nfine' });
  assert.equal(received[1].message, 'Subject: x\r\n\r\n..starts with a dot\r\nfine', 'dot-stuffed on the wire');
});

test('SMTP: sign-in with LOGIN, and every refusal said', async (t) => {
  const login = await fakeSmtp(t, { offer: ['AUTH LOGIN'] });
  await createMailer({ provider: 'smtp', host: '127.0.0.1', port: login.port, secure: 'none', user: 'next', password: 'pw', from: 'a@example.com' })
    .send({ to: 'b@example.com', subject: 's', text: 't' });
  assert.equal(login.received[0].password, 'pw');

  const wrong = await fakeSmtp(t);
  await assert.rejects(createMailer({ provider: 'smtp', host: '127.0.0.1', port: wrong.port, secure: 'none', user: 'next', password: 'wrong', from: 'a@example.com' })
    .send({ to: 'b@example.com', subject: 's', text: 't' }), /535 5\.7\.8 Bad credentials/);

  const refusing = await fakeSmtp(t, { refuseRcpt: true });
  await assert.rejects(createMailer({ provider: 'smtp', host: '127.0.0.1', port: refusing.port, secure: 'none', from: 'a@example.com' })
    .send({ to: 'b@example.com', subject: 's', text: 't' }), /550 5\.1\.1 No such user/);

  const plain = await fakeSmtp(t, { offer: [] });
  await assert.rejects(createMailer({ provider: 'smtp', host: '127.0.0.1', port: plain.port, secure: 'starttls', from: 'a@example.com' })
    .send({ to: 'b@example.com', subject: 's', text: 't' }), /does not offer STARTTLS/, 'never in clear unless told');

  await assert.rejects(createMailer({ provider: 'smtp', host: '127.0.0.1', port: 9, secure: 'none', from: 'a@example.com' })
    .send({ to: 'b@example.com', subject: 's', text: 't' }), MailError);
});

test('SMTP: checking the server and the account without sending anything', async (t) => {
  const server = await fakeSmtp(t);
  const config = { provider: 'smtp', host: '127.0.0.1', port: server.port, secure: 'none', user: 'next', password: 'right', from: 'Next <next@example.com>' };
  assert.deepEqual(await createMailer(config).verify(), { provider: 'smtp', host: '127.0.0.1', port: server.port });
  await checkSmtp(config);
  assert.equal(server.received.length, 0, 'nothing sent');
  await assert.rejects(createMailer({ ...config, password: 'wrong' }).verify(), /535 5\.7\.8 Bad credentials/);
  await assert.rejects(createMailer({ ...config, port: 9 }).verify(), MailError);
  assert.deepEqual(await createMailer({ provider: 'log' }).verify(), { provider: 'log' }, 'the log can always take a message');
});
