/**
 * Outgoing mail: an SMTP server (MAIL_PROVIDER=smtp) or, by default, the
 * server's log (MAIL_PROVIDER=log). In development, and in an install that
 * hasn't set a server yet, a message shows up in the log instead of going
 * nowhere: whoever runs the install can still pass a reset link on.
 *
 * The SMTP client is small and has no dependencies (node:net, node:tls):
 * implicit TLS (port 465) or STARTTLS (587, required unless MAIL_SECURE=none,
 * which is only for a relay on the same machine), AUTH PLAIN or LOGIN, one
 * message per connection. Messages are UTF-8 plain text, with an optional
 * HTML part; headers can't be broken into (no line breaks get through).
 */
import crypto from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';

const TIMEOUT_MS = 15000;

/** A message could not be sent: the server refused it or didn't answer. */
export class MailError extends Error {}

export function mailConfigFromEnv(env = process.env) {
  const port = Number(env.MAIL_PORT) || (env.MAIL_SECURE === 'tls' ? 465 : 587);
  return {
    provider: env.MAIL_PROVIDER || 'log',
    from: env.MAIL_FROM || '',
    host: env.MAIL_HOST || '',
    port,
    secure: env.MAIL_SECURE || (port === 465 ? 'tls' : 'starttls'),
    user: env.MAIL_USER || '',
    password: env.MAIL_PASSWORD || '',
  };
}

/** What is wrong with a mail configuration; empty when it can be used. */
export function mailConfigErrors(config) {
  const errors = [];
  if (!['log', 'smtp'].includes(config.provider)) errors.push(`MAIL_PROVIDER "${config.provider}": use smtp or log`);
  if (config.provider !== 'smtp') return errors;
  if (!config.host) errors.push('MAIL_PROVIDER=smtp needs MAIL_HOST');
  if (!parseAddress(config.from)) errors.push('MAIL_PROVIDER=smtp needs MAIL_FROM, like "Next <next@example.com>"');
  if (!['tls', 'starttls', 'none'].includes(config.secure)) errors.push(`MAIL_SECURE "${config.secure}": use tls, starttls or none`);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) errors.push('MAIL_PORT must be a port number');
  if (Boolean(config.user) !== Boolean(config.password)) errors.push('MAIL_USER and MAIL_PASSWORD go together');
  return errors;
}

/* -------------------------------- messages -------------------------------- */

const EMAIL = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;
const oneLine = (text) => String(text ?? '').replace(/[\r\n]+/g, ' ').trim();

/** "Name <address>" or a bare address → { name, address }; null when it isn't one. */
export function parseAddress(text) {
  const clean = oneLine(text);
  const match = /^(?:"?([^"<]*?)"?\s*)?<([^<>]+)>$/.exec(clean);
  const address = (match ? match[2] : clean).trim();
  if (!EMAIL.test(address)) return null;
  return { name: match ? match[1].trim() : '', address };
}

/** A header value in UTF-8 when it needs it (RFC 2047), as is when plain ASCII. */
const encodeWord = (text) => (/^[\x20-\x7e]*$/.test(text)
  ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`);

const formatAddress = ({ name, address }) => (name ? `${encodeWord(name.replace(/"/g, ''))} <${address}>` : address);

const base64Lines = (text) => Buffer.from(String(text), 'utf8').toString('base64').replace(/.{76}(?=.)/g, '$&\r\n');

/**
 * The message as it travels (RFC 5322 + MIME): UTF-8 text in base64, and a
 * multipart/alternative when there is an HTML part too.
 */
export function buildMessage({ from, to, subject, text, html = null, date = new Date(), domain = 'localhost' }) {
  const sender = parseAddress(from);
  const recipient = parseAddress(to);
  if (!sender || !recipient) throw new MailError('A sender and a recipient address are needed');
  const headers = [
    `From: ${formatAddress(sender)}`,
    `To: ${formatAddress(recipient)}`,
    `Subject: ${encodeWord(oneLine(subject))}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  if (!html) {
    return [...headers, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '',
      base64Lines(text)].join('\r\n');
  }
  const boundary = `b_${crypto.randomBytes(12).toString('hex')}`;
  return [...headers, `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(text),
    `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(html),
    `--${boundary}--`, ''].join('\r\n');
}

/* ---------------------------------- SMTP ---------------------------------- */

/** One conversation with the server: send a line, wait for the reply, with a timeout. */
function conversation(socket, timeoutMs) {
  let buffer = '';
  let waiting = null;
  let current = socket;
  const replies = [];
  // A reply that arrives before anyone waits for it is kept for the next wait.
  const early = [];

  const onData = (chunk) => {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      replies.push(line);
      // The last line of a reply is "250 …"; the ones before it are "250-…".
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const answer = { code: Number(line.slice(0, 3)), lines: replies.splice(0).map((l) => l.slice(4)) };
        if (waiting) {
          const { resolve } = waiting;
          waiting = null;
          resolve(answer);
        } else {
          early.push(answer);
        }
      }
    }
  };
  const onError = (err) => { if (waiting) { waiting.reject(err); waiting = null; } };
  const onClose = () => onError(new MailError('The mail server closed the connection'));

  const attach = (s) => {
    s.on('data', onData);
    s.on('error', onError);
    s.on('close', onClose);
  };
  const detach = (s) => {
    s.off('data', onData);
    s.off('error', onError);
    s.off('close', onClose);
  };
  attach(socket);

  function reply(expected) {
    return new Promise((resolve, reject) => {
      const check = (answer) => (expected.includes(answer.code) ? resolve(answer)
        : reject(new MailError(`The mail server answered ${answer.code} ${answer.lines.join(' ')}`.trim())));
      if (early.length) {
        check(early.shift());
        return;
      }
      const timer = setTimeout(() => {
        waiting = null;
        reject(new MailError('The mail server did not answer in time'));
        current.destroy();
      }, timeoutMs);
      waiting = {
        resolve: (answer) => { clearTimeout(timer); check(answer); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      };
    });
  }

  return {
    reply,
    command(line, expected) {
      current.write(`${line}\r\n`);
      return reply(expected);
    },
    /** STARTTLS: the same connection, encrypted from here on. */
    async upgrade(host) {
      detach(current);
      const secure = tls.connect({ socket: current, servername: host });
      await new Promise((resolve, reject) => {
        secure.once('secureConnect', resolve);
        secure.once('error', reject);
      });
      current = secure;
      attach(current);
    },
    close() { current.end(); },
    destroy() { current.destroy(); },
  };
}

async function openSocket({ host, port, secure }, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = secure === 'tls'
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new MailError(`No answer from the mail server ${host}:${port}`));
    }, timeoutMs);
    socket.once(secure === 'tls' ? 'secureConnect' : 'connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', (err) => { clearTimeout(timer); reject(new MailError(`The mail server ${host}:${port}: ${err.message}`)); });
  });
}

const capabilities = (answer) => new Set(answer.lines.slice(1).map((l) => l.toUpperCase()));
const authMethods = (caps) => new Set([...caps].filter((c) => c.startsWith('AUTH')).flatMap((c) => c.slice(5).split(/\s+/)));

/** Connects, says hello, encrypts and signs in: what sending and checking share. */
async function openSession(config, { timeoutMs, helo }) {
  const socket = await openSocket(config, timeoutMs);
  const smtp = conversation(socket, timeoutMs);
  try {
    await smtp.reply([220]);
    let caps = capabilities(await smtp.command(`EHLO ${helo}`, [250]));
    if (config.secure === 'starttls') {
      if (!caps.has('STARTTLS')) throw new MailError('The mail server does not offer STARTTLS (MAIL_SECURE=none to go without)');
      await smtp.command('STARTTLS', [220]);
      await smtp.upgrade(config.host);
      caps = capabilities(await smtp.command(`EHLO ${helo}`, [250]));
    }
    if (config.user) {
      const methods = authMethods(caps);
      if (methods.has('PLAIN')) {
        const token = Buffer.from(`\0${config.user}\0${config.password}`, 'utf8').toString('base64');
        await smtp.command(`AUTH PLAIN ${token}`, [235]);
      } else if (methods.has('LOGIN')) {
        await smtp.command('AUTH LOGIN', [334]);
        await smtp.command(Buffer.from(config.user, 'utf8').toString('base64'), [334]);
        await smtp.command(Buffer.from(config.password, 'utf8').toString('base64'), [235]);
      } else {
        throw new MailError('The mail server offers no sign-in this client knows (PLAIN, LOGIN)');
      }
    }
    return smtp;
  } catch (err) {
    smtp.destroy();
    throw err;
  }
}

/**
 * Checks an SMTP server without sending anything: it answers, encrypts as
 * told, and takes the account. Throws a MailError that says what failed.
 */
export async function checkSmtp(config, { timeoutMs = TIMEOUT_MS, helo = 'localhost' } = {}) {
  const smtp = await openSession(config, { timeoutMs, helo });
  try {
    await smtp.command('QUIT', [221]).catch(() => {});
  } finally {
    smtp.destroy();
  }
}

/** Sends one message through an SMTP server. */
export async function sendSmtp(config, { from, to, message, timeoutMs = TIMEOUT_MS, helo = 'localhost' }) {
  const smtp = await openSession(config, { timeoutMs, helo });
  try {
    await smtp.command(`MAIL FROM:<${parseAddress(from).address}>`, [250]);
    await smtp.command(`RCPT TO:<${parseAddress(to).address}>`, [250, 251]);
    await smtp.command('DATA', [354]);
    // A line that starts with a dot gets another one, or it would end the message early.
    const body = message.split('\r\n').map((line) => (line.startsWith('.') ? `.${line}` : line)).join('\r\n');
    const accepted = await smtp.command(`${body}\r\n.`, [250]);
    await smtp.command('QUIT', [221]).catch(() => {});
    return { response: accepted.lines.join(' ') };
  } finally {
    smtp.destroy();
  }
}

/* --------------------------------- mailer --------------------------------- */

/**
 * @param {object} config   from mailConfigFromEnv()
 * @returns {{ provider, send({ to, subject, text, html? }) → Promise, verify() → Promise }}
 */
export function createMailer(config, { log = console.log, send = sendSmtp, check = checkSmtp } = {}) {
  const errors = mailConfigErrors(config);
  if (errors.length) throw new MailError(errors.join('; '));
  const from = config.from || 'no-reply@localhost';
  const domain = parseAddress(from)?.address.split('@')[1] || 'localhost';

  async function deliver({ to, subject, text, html = null }) {
    if (!parseAddress(to)) throw new MailError(`"${oneLine(to)}" is not an email address`);
    if (config.provider === 'log') {
      log(`[mail] to ${oneLine(to)}: ${oneLine(subject)}\n${text}`);
      return { logged: true };
    }
    const message = buildMessage({ from, to, subject, text, html, domain });
    return send(config, { from, to, message, helo: domain });
  }

  /** Whether mail can go out now: the SMTP server answers and takes the account. The log always can. */
  async function verify() {
    if (config.provider === 'log') return { provider: 'log' };
    await check(config, { helo: domain });
    return { provider: 'smtp', host: config.host, port: config.port };
  }

  return { provider: config.provider, from, send: deliver, verify };
}
