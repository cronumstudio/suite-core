/*
 * The light or dark theme before the first paint (a classic script, loaded in
 * <head>): the one the server already wrote, else the one saved in this
 * browser —the app's own (`<app>.theme`, when the page names the app with
 * data-app, as the OAuth consent screen does) or the suite's—, else the
 * system's. The page applies the person's own choice once it knows who they are.
 */
(function () {
  var root = document.documentElement;
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
