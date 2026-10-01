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

import { escapeHtml, appStyle, SIGNATURE, textOn } from './brand.js';

// Still exported from here: apps and tests imported it before brand.js existed.
export { textOn };

/**
 * @param {object} app   config.app: { id, name, color, icon }
 * @returns page({ lang, title, body, theme }) → the HTML of a screen. `theme`
 *   is the person's own choice when the server knows it ('light' | 'dark');
 *   without it, /suite/theme.js takes the one the app saved in this browser.
 */
export function brandedPage({ id, name, color = null, icon = '/icons/favicon.svg' }) {
  const style = appStyle(color);
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
