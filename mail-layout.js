/**
 * The suite's emails as HTML: one layout for every message, in the product's
 * clothes (its icon, its name, its colour), that reads the same in Gmail,
 * Outlook and Apple Mail, on a phone and in dark mode. Tables and inline
 * styles, which is what every mail client still agrees on; the <style> block
 * only adds what the clients that read it do better (dark mode, a phone's
 * width), and Outlook on Windows gets its button drawn in VML.
 *
 * Nothing that filters spam frowns on: a plain-text part that says the same
 * (mail.js sends both), no hidden text, few and small images from the
 * product's own address, every link to it, no tracking.
 *
 *   const brand = mailBrand(config.app, baseUrl);
 *   const { html, text } = renderMail({ lang, brand, heading, lead, button: { label, href }, … });
 *
 * Everything that goes in is text and is escaped here; a link or an image
 * that isn't http(s) is left out.
 */

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
const web = (value) => /^https?:\/\/[^\s"'<>]+$/i.test(String(value ?? ''));
const absolute = (base, value) => (value && !web(value) ? `${String(base).replace(/\/+$/, '')}${value}` : value);

const INK = '#16130E';
const CREAM = '#FFF7E6';
const STONE = '#7A7064';
const YOLK = '#FFC21A';
const PAGE = '#F4EBD8';
const SHEET = '#FFFDF8';
const LINE = '#EADFC6';
const DARK = { page: INK, sheet: '#221E17', card: '#2B261D', line: '#352F25', stone: '#B8AE9F' };
const FONT = "'Geist','Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif";
const DISPLAY = "'Space Grotesk','Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif";

/**
 * How a product signs its emails, from its suite.config.js `app` (config.js):
 * its name, its colour, its icon as a PNG at its own address (`app.mail.icon`;
 * mail clients don't show SVG) and, optional, a lighter colour for dark mode,
 * a line under its name and what it is, by language.
 */
export function mailBrand(app, baseUrl) {
  const mail = app?.mail || {};
  return {
    name: app?.name || '',
    url: `${String(baseUrl || '').replace(/\/+$/, '')}/`,
    color: app?.color || INK,
    colorOnDark: mail.colorOnDark || null,
    icon: mail.icon ? absolute(baseUrl, mail.icon) : null,
    signature: mail.signature || null,
    about: mail.about || null,
  };
}

/** A paragraph per blank line, a line break per line. */
const paragraphs = (text, style) => String(text ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean)
  .map((p) => `<p class="stone" style="${style}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');

/** The product's name as its logotype writes it: lowercase, the first word bold ("cronum work"). */
function wordmark(name) {
  const [first, ...rest] = String(name).toLowerCase().split(/\s+/).filter(Boolean);
  return `<b style="font-weight:700">${esc(first)}</b>${rest.length ? ` <span style="font-weight:500">${esc(rest.join(' '))}</span>` : ''}`;
}

/** The heading ends with the yolk dot, the brand's "now", unless it ends with its own sign. */
const headingOf = (text) => {
  const clean = String(text ?? '').trim().replace(/\.$/, '');
  return /[?!…]$/.test(clean) ? esc(clean) : `${esc(clean)}<span style="color:${YOLK}">.</span>`;
};

/**
 * The message, as HTML and as plain text.
 *
 * @param {object} m
 * @param {string} m.lang                  its language (the page's `lang`)
 * @param {object} m.brand                 from mailBrand()
 * @param {object} [m.eyebrow]             { text, color }: a short line over the heading
 * @param {string} m.heading               the big line
 * @param {string} [m.lead]                what it is about (paragraphs split by a blank line)
 * @param {object} [m.card]                what is offered: { icon, title, meta }
 * @param {object} [m.button]              { label, href }: the one thing to do
 * @param {string} [m.note]                small print under the button
 * @param {object} [m.about]               { title, text }: what the product is, for whoever doesn't know it
 * @param {string} [m.footer]              under the sheet: why it came
 * @returns {{ html: string, text: string }}
 */
export function renderMail(m) {
  const b = m.brand;
  const accent = b.color;
  const onDark = b.colorOnDark || accent;
  const button = m.button && web(m.button.href) ? m.button : null;
  const pad = 'padding-left:40px;padding-right:40px';

  const eyebrow = m.eyebrow?.text ? `
          <tr><td class="px" style="padding-top:32px;${pad}">
            <span style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${m.eyebrow.color || accent}">${esc(m.eyebrow.text)}</span>
          </td></tr>` : '';
  const lead = m.lead ? `
          <tr><td class="px" style="padding-top:12px;${pad}">
            ${paragraphs(m.lead, `margin:0 0 12px;font-family:${FONT};font-size:16px;line-height:24px;color:${STONE}`)}
          </td></tr>` : '';
  const card = m.card ? `
          <tr><td class="px" style="padding-top:12px;padding-bottom:4px;${pad}">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="card"
              style="background:${CREAM};border:1px solid #EFE3C8;border-radius:16px;border-collapse:separate">
              <tr>
                ${web(m.card.icon) ? `<td width="60" valign="middle" style="padding:16px 0 16px 16px">
                  <img src="${esc(m.card.icon)}" width="44" height="44" alt="" style="display:block;border:0;border-radius:11px">
                </td>` : ''}
                <td valign="middle" style="padding:16px 16px 16px ${web(m.card.icon) ? 12 : 18}px;font-family:${FONT}">
                  <div class="ink" style="font-size:17px;line-height:23px;font-weight:600;color:${INK}">${esc(m.card.title)}</div>
                  ${m.card.meta ? `<div class="stone" style="font-size:14px;line-height:20px;color:${STONE};padding-top:2px">${esc(m.card.meta)}</div>` : ''}
                </td>
              </tr>
            </table>
          </td></tr>` : '';
  const action = button ? `
          <tr><td class="px" style="padding-top:24px;${pad}">
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn"><tr>
              <td align="center" bgcolor="${accent}" style="border-radius:12px;background:${accent}">
                <!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" href="${esc(button.href)}" style="height:48px;v-text-anchor:middle;width:260px" arcsize="25%" stroke="f" fillcolor="${accent}"><center style="color:${CREAM};font-family:'Segoe UI',Arial,sans-serif;font-size:16px;font-weight:bold">${esc(button.label)}</center></v:roundrect><![endif]-->
                <!--[if !mso]><!--><a href="${esc(button.href)}" style="display:inline-block;padding:14px 28px;font-family:${FONT};font-size:16px;line-height:20px;font-weight:600;color:${CREAM};text-decoration:none;border-radius:12px;background:${accent}">${esc(button.label)}</a><!--<![endif]-->
              </td>
            </tr></table>
          </td></tr>` : '';
  const note = m.note ? `
          <tr><td class="px" style="padding-top:16px;${pad}">
            ${paragraphs(m.note, `margin:0 0 8px;font-family:${FONT};font-size:13px;line-height:19px;color:${STONE}`)}
          </td></tr>` : '';
  const about = m.about?.text ? `
          <tr><td class="px" style="padding-top:20px;${pad}"><div class="rule" style="height:1px;line-height:1px;font-size:0;background:${LINE}">&nbsp;</div></td></tr>
          <tr><td class="px" style="padding-top:22px;${pad}">
            <div class="ink" style="font-family:${DISPLAY};font-size:15px;line-height:21px;font-weight:700;color:${INK};padding-bottom:6px">${esc(m.about.title)}</div>
            ${paragraphs(m.about.text, `margin:0;font-family:${FONT};font-size:14px;line-height:21px;color:${STONE}`)}
          </td></tr>` : '';
  const icon = web(b.icon)
    ? `<td valign="middle" style="padding-right:10px"><img src="${esc(b.icon)}" width="36" height="36" alt="" style="display:block;border:0;border-radius:9px"></td>` : '';

  const html = `<!doctype html>
<html lang="${esc(m.lang)}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(m.heading)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<style>
  :root { color-scheme: light dark; supported-color-schemes: light dark; }
  body { margin:0; padding:0; -webkit-text-size-adjust:100%; }
  @media (max-width: 620px) {
    .shell { width:100% !important; }
    .px { padding-left:24px !important; padding-right:24px !important; }
    .h1 { font-size:26px !important; line-height:32px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg { background:${DARK.page} !important; }
    .sheet { background:${DARK.sheet} !important; border-color:${DARK.line} !important; }
    .card { background:${DARK.card} !important; border-color:${DARK.line} !important; }
    .rule { background:${DARK.line} !important; }
    .ink { color:${CREAM} !important; }
    .stone { color:${DARK.stone} !important; }
    .btn td, .btn a { background:${onDark} !important; color:${b.colorOnDark ? INK : CREAM} !important; }
    .link { color:${onDark} !important; }
  }
  [data-ogsc] .ink { color:${CREAM} !important; }
  [data-ogsc] .stone { color:${DARK.stone} !important; }
  [data-ogsb] .bg { background:${DARK.page} !important; }
  [data-ogsb] .sheet { background:${DARK.sheet} !important; }
  [data-ogsb] .card { background:${DARK.card} !important; }
</style>
</head>
<body class="bg" style="margin:0;padding:0;background:${PAGE}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="bg" style="background:${PAGE}">
  <tr><td align="center" style="padding:32px 12px">
    <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" class="shell" style="width:560px;max-width:560px">
      <tr><td style="padding:0 8px 18px">
        <a href="${esc(b.url)}" style="text-decoration:none">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
            ${icon}
            <td valign="middle" class="ink" style="font-family:${DISPLAY};font-size:21px;line-height:24px;letter-spacing:-0.04em;color:${INK}">${wordmark(b.name)}</td>
          </tr></table>
        </a>
      </td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="sheet"
          style="background:${SHEET};border:1px solid ${LINE};border-radius:20px;border-collapse:separate">
          ${eyebrow}
          <tr><td class="px" style="padding-top:${eyebrow ? 10 : 36}px;${pad}">
            <h1 class="h1 ink" style="margin:0;font-family:${DISPLAY};font-size:30px;line-height:36px;font-weight:700;letter-spacing:-0.03em;color:${INK}">${headingOf(m.heading)}</h1>
          </td></tr>
          ${lead}${card}${action}${note}${about}
          <tr><td style="height:32px;line-height:32px;font-size:0">&nbsp;</td></tr>
        </table>
      </td></tr>
      <tr><td align="center" style="padding:22px 16px 0">
        ${paragraphs(m.footer, `margin:0 0 6px;font-family:${FONT};font-size:12px;line-height:18px;color:${STONE};text-align:center`)}
        <p class="stone" style="margin:8px 0 0;font-family:${FONT};font-size:12px;line-height:18px;color:${STONE};text-align:center">
          <a class="link" href="${esc(b.url)}" style="color:${accent};text-decoration:none;font-weight:600">${esc(b.name)}</a>${b.signature ? ` · ${esc(b.signature)}` : ''}
        </p>
      </td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `${String(m.heading ?? '').trim().replace(/\.$/, '')}${/[?!…]$/.test(String(m.heading ?? '').trim()) ? '' : '.'}`,
    m.lead,
    m.card ? [m.card.title, m.card.meta].filter(Boolean).join('\n') : null,
    button ? `${button.label}: ${button.href}` : null,
    m.note,
    m.about?.text ? `${m.about.title}\n${m.about.text}` : null,
    m.footer,
    [b.name, b.signature].filter(Boolean).join(' · '),
  ].filter((part) => part && String(part).trim()).map((part) => String(part).trim()).join('\n\n');

  return { html, text };
}

/**
 * One of the account's messages (a link to confirm an email, a new password,
 * an invitation, a deletion), written as plain text with its link on a line of
 * its own: the same words, with the link as the button. What comes before the
 * link is the lead, what comes after it the small print (a link inside a
 * sentence stays there, and the button follows the words); the last line, the
 * product's name alone, is the layout's own.
 */
export function accountMail({ lang, brand, subject, body, link, button }) {
  const parts = String(body ?? '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.at(-1) === brand.name) parts.pop();
  const at = parts.findIndex((p) => p === link);
  const before = at < 0 ? parts : parts.slice(0, at);
  const after = at < 0 ? [] : parts.slice(at + 1);
  const { html } = renderMail({
    lang, brand, heading: subject, lead: before.join('\n\n'),
    button: web(link) ? { label: button, href: link } : null, note: after.join('\n\n'),
  });
  return html;
}
