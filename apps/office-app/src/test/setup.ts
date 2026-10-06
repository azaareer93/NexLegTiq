import { configure } from '@testing-library/react';

// Pages are lazy-loaded: the first test to open one waits for a cold import, which takes over a second on a busy runner.
configure({ asyncUtilTimeout: 5000 });

/**
 * jsdom has no `matchMedia`; AntD's grid and `Grid.useBreakpoint` read breakpoints from it. Width queries are answered
 * against `window.innerWidth` (jsdom: 1024 px), so a test can set the viewport (`setViewport` in render-app) before rendering.
 */
function matches(query: string): boolean {
  const width = window.innerWidth;
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])) && (min !== null || max !== null);
}

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList,
});

// jsdom has no `ResizeObserver`; AntD's Menu (overflow handling) observes its items. No layout here, so nothing to report.
globalThis.ResizeObserver ??= class {
  observe = (): undefined => undefined;
  unobserve = (): undefined => undefined;
  disconnect = (): undefined => undefined;
};
