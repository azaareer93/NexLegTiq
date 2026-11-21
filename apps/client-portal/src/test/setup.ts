import { configure } from '@testing-library/react';

import { resetMedia } from './media';

// Pages are lazy-loaded: the first test to open one waits for a cold import.
configure({ asyncUtilTimeout: 5000 });

// `matchMedia` answers from the window width (media.ts, copied from office-app); AntD reads breakpoints from it.
afterEach(resetMedia);

// jsdom has no `ResizeObserver`; AntD's Table/Select observe their size. No layout here, so nothing to report.
globalThis.ResizeObserver ??= class {
  observe = (): undefined => undefined;
  unobserve = (): undefined => undefined;
  disconnect = (): undefined => undefined;
};
