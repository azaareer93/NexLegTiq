import { configure } from '@testing-library/react';

// Pages are lazy-loaded: the first test to open one waits for a cold import, which takes over a second on a busy runner.
configure({ asyncUtilTimeout: 5000 });

// jsdom has no `matchMedia`; AntD's grid (Form.Item rows) reads breakpoints from it. Every query reports "no match".
Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList,
});
