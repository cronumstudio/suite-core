/*
 * The light or dark theme before the first paint (a classic script, loaded in
 * <head>): the one saved in this browser, else the system's. The page applies
 * the person's own choice once it knows who they are.
 */
(function () {
  var theme = 'light';
  try {
    var saved = localStorage.getItem('suite.theme');
    var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    theme = saved === 'dark' || saved === 'light' ? saved : (dark ? 'dark' : 'light');
  } catch (err) { /* no storage: the default */ }
  document.documentElement.setAttribute('data-theme', theme);
}());
