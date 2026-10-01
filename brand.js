/**
 * The Cronum Studio brand as the suite's own screens wear it (the OAuth
 * consent screen, the admin panel): the product's colour as a style attribute,
 * the text that reads on it, and the "by Cronum Studio" signature, whose
 * colours each stylesheet sets for its background.
 */

export const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

export const INK = '#16130E';

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

/** ` style="--app: …; --app-on: …"` for the <html> of a page, or nothing without a colour. */
export const appStyle = (color) => (color ? ` style="--app: ${color}; --app-on: ${textOn(color)}"` : '');

/** The signature: the ring in line, so it follows the page's theme rather than the system's. */
export const SIGNATURE = `<a class="cronum-sig" href="https://cronumstudio.com" target="_blank" rel="noopener">
<span>by</span>
<svg viewBox="0 0 100 100" aria-hidden="true"><path d="M50 14A36 36 0 1 0 86 50"/><circle cx="76.87" cy="23.13" r="10"/></svg>
<strong>Cronum Studio</strong>
</a>`;

/**
 * The admin panel's page (web/admin.html) for this app: its id (for the
 * theme it saved), its colour and its icon, and the signature.
 */
export const brandedAdmin = (template, { id, color = null, icon = '/icons/favicon.svg' }) => template
  .replace('{{app.id}}', escapeHtml(id))
  .replace('{{app.style}}', appStyle(color))
  .replace('{{app.icon}}', escapeHtml(icon))
  .replace('{{signature}}', SIGNATURE);
