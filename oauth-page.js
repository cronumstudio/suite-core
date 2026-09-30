/**
 * The OAuth consent and error screens as every app of the suite shows them,
 * unless it dresses them itself (the `oauthPage` hook): the Cronum yolk behind,
 * a card with the app's icon, name and colour, and the "by Cronum Studio"
 * signature under it.
 *
 * Everything comes from the app itself: the screen's CSP loads styles, scripts
 * and images only from 'self', so no web fonts and nothing from elsewhere. The
 * product's colour goes in a style attribute, which that CSP allows.
 */

const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const INK = '#16130E';

/** WCAG relative luminance of a #RRGGBB colour. */
function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * The text on a button of the product's colour: white, as the apps' own
 * buttons have it, unless the colour is so light that white stops reading
 * (under 3:1, the ratio for large and bold text); then ink.
 */
export function textOn(hex) {
  return 1.05 / (luminance(hex) + 0.05) >= 3 ? '#FFFFFF' : INK;
}

/** The ring of the signature: its colours follow the theme (oauth.css). */
const SIGNATURE = `<a class="cronum-sig" href="https://cronumstudio.com" target="_blank" rel="noopener">
<span>by</span>
<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 14A36 36 0 1 0 86 50"/><circle cx="76.87" cy="23.13" r="10"/></svg>
<strong>Cronum Studio</strong>
</a>`;

/**
 * @param {object} app   config.app: { id, name, color, icon }
 * @returns page({ lang, title, body, theme }) → the HTML of a screen. `theme`
 *   is the person's own choice when the server knows it ('light' | 'dark');
 *   without it, /suite/theme.js takes the one the app saved in this browser.
 */
export function brandedPage({ id, name, color = null, icon = '/icons/favicon.svg' }) {
  const style = color ? ` style="--app: ${color}; --app-on: ${textOn(color)}"` : '';
  const head = `<link rel="icon" href="${escapeHtml(icon)}" type="image/svg+xml">
<link rel="stylesheet" href="/suite/oauth.css">
<script src="/suite/theme.js"></script>`;
  const brand = `<div class="consent__app"><img src="${escapeHtml(icon)}" alt="" width="44" height="44"><span>${escapeHtml(name)}</span></div>`;

  return ({ lang, title, body, theme = null }) => `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}" data-app="${escapeHtml(id)}"${theme === 'light' || theme === 'dark' ? ` data-theme="${theme}"` : ''}${style}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · ${escapeHtml(name)}</title>
${head}
</head>
<body class="consent-page">
<main class="consent">
<div class="consent__card oauth">
${brand}
${body}
</div>
${SIGNATURE}
</main>
</body>
</html>`;
}
