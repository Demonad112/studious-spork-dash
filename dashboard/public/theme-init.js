// Runs before first paint so the page never flashes the wrong theme. A separate file because the
// Content-Security-Policy forbids inline scripts.
(function () {
  var mode = null;
  try {
    mode = localStorage.getItem('rc-theme');
  } catch (e) {
    mode = null;
  }
  var dark =
    mode === 'dark' ||
    (mode !== 'light' &&
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
