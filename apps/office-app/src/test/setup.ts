import { configure } from '@testing-library/react';

import { resetMedia } from './media';

// Pages are lazy-loaded: the first test to open one waits for a cold import, which takes over a second on a busy runner.
configure({ asyncUtilTimeout: 5000 });

// `matchMedia` answers from the window width (media.ts); every test starts at jsdom's 1024 px.
afterEach(resetMedia);

// jsdom has no `ResizeObserver`; AntD's Menu (overflow handling) observes its items. No layout here, so nothing to report.
globalThis.ResizeObserver ??= class {
  observe = (): undefined => undefined;
  unobserve = (): undefined => undefined;
  disconnect = (): undefined => undefined;
};
