/*
 * The light or dark theme before the first paint (a classic script, loaded in
 * <head>): the one the server already wrote, else the one saved in this
 * browser —the app's own (`<app>.theme`, when the page names the app with
 * data-app, as the OAuth consent screen does) or the suite's—, else the
 * system's. The page applies the person's own choice once it knows who they are.
 *
 * In a host, the look the person chose last time in this browser too
 * (`host.look`, kept by shell.js from GET /api/modules): `clean` paints the
 * Clean look from the start; the suite's own look needs nothing.
 */
(function () {
  var root = document.documentElement;
  try {
    if (!root.getAttribute('data-look') && localStorage.getItem('host.look') === 'clean') root.setAttribute('data-look', 'clean');
  } catch (err) { /* no storage: the suite's look */ }
  if (root.getAttribute('data-theme')) return;
  var theme = 'light';
  try {
    var app = root.getAttribute('data-app');
    var saved = (app && localStorage.getItem(app + '.theme')) || localStorage.getItem('suite.theme');
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = saved === 'dark' || saved === 'light' ? saved : (dark ? 'dark' : 'light');
  } catch (err) { /* no storage: the default */ }
  root.setAttribute('data-theme', theme);
}());

/*
 * The status bar in the page's ground, for a page whose theme-color asks for it
 * (`<meta name="theme-color" data-kit-ground>`, before this script): an app on
 * an iPhone's Home Screen with the opaque status bar (style `default`), and
 * Android's. Painted once the page is there and again whenever its theme or
 * look changes, as the ground does (Cronum Work's shell paints its own).
 */
(function () {
  var root = document.documentElement;
  var metas = document.querySelectorAll('meta[name="theme-color"][data-kit-ground]');
  if (!metas.length || !window.MutationObserver) return;
  var painted = null;
  function paint() {
    if (!document.body) return;
    var color = rgbOf(getComputedStyle(document.body).backgroundColor);
    if (!color || color === painted) return;
    painted = color;
    for (var i = 0; i < metas.length; i++) metas[i].setAttribute('content', color);
  }
  // The kit's grounds are mixed in oklab, which a theme-color may not take: as `rgb()`.
  function rgbOf(color) {
    var pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (!pen) return null;
    pen.fillStyle = color;
    pen.fillRect(0, 0, 1, 1);
    var px = pen.getImageData(0, 0, 1, 1).data;
    return px[3] ? 'rgb(' + px[0] + ', ' + px[1] + ', ' + px[2] + ')' : null;
  }
  // Once the page is there, and again once its sheets surely are.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
  window.addEventListener('load', paint);
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-look', 'data-app', 'style'] });
}());
