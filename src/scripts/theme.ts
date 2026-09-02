type Theme = 'light' | 'dark';

const mediaQuery = globalThis.matchMedia('(prefers-color-scheme: dark)');

const explicitTheme = (): Theme | undefined => {
  try {
    const saved = localStorage.getItem('theme');
    return saved === 'light' || saved === 'dark' ? saved : undefined;
  } catch {
    return undefined;
  }
};

const systemTheme = (): Theme => (mediaQuery.matches ? 'dark' : 'light');

const updateThemeColor = () => {
  const background = getComputedStyle(document.documentElement)
    .getPropertyValue('--site-background')
    .trim();
  document
    .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', background);
};

const updateToggle = (toggle: HTMLButtonElement, theme: Theme) => {
  const nextTheme = theme === 'dark' ? 'light' : 'dark';
  const label = `Switch to ${nextTheme} mode`;
  toggle.setAttribute('aria-label', label);
  toggle.setAttribute('title', label);
};

const applyTheme = () => {
  const theme = explicitTheme() ?? systemTheme();
  document.documentElement.dataset.theme = theme;
  for (const toggle of document.querySelectorAll<HTMLButtonElement>(
    '[data-theme-toggle], [data-tool-theme-toggle]',
  ))
    updateToggle(toggle, theme);
  requestAnimationFrame(updateThemeColor);
};

const bindToggles = () => {
  for (const toggle of document.querySelectorAll<HTMLButtonElement>(
    '[data-theme-toggle], [data-tool-theme-toggle]',
  )) {
    if (toggle.dataset.themeReady === 'true') continue;
    toggle.dataset.themeReady = 'true';
    toggle.addEventListener('click', () => {
      const current =
        document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
      try {
        localStorage.setItem('theme', current === 'dark' ? 'light' : 'dark');
      } catch {
        // The visual theme can still change when storage is unavailable.
      }
      applyTheme();
    });
  }
};

const syncTheme = () => {
  applyTheme();
  bindToggles();
};

mediaQuery.addEventListener('change', () => {
  if (!explicitTheme()) applyTheme();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') applyTheme();
});
window.addEventListener('pageshow', applyTheme);
document.addEventListener('astro:page-load', syncTheme);
document.addEventListener('astro:before-swap', (event) => {
  const theme = explicitTheme() ?? systemTheme();
  (
    event as Event & { newDocument: Document }
  ).newDocument.documentElement.dataset.theme = theme;
});

syncTheme();
