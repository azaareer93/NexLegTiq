import { act } from '@testing-library/react';

/**
 * jsdom has no `matchMedia`; AntD's grid and `Grid.useBreakpoint` read breakpoints from it. Width queries are answered
 * against `window.innerWidth` (jsdom: 1024 px), and `resizeTo` changes the width and notifies every listener, like a
 * browser window being resized.
 */
function matches(query: string): boolean {
  const width = window.innerWidth;
  const min = /min-width:\s*(\d+)px/.exec(query);
  const max = /max-width:\s*(\d+(?:\.\d+)?)px/.exec(query);
  return (!min || width >= Number(min[1])) && (!max || width <= Number(max[1])) && (min !== null || max !== null);
}

type Listener = (event: { matches: boolean; media: string }) => void;
const queries = new Set<{ media: string; listeners: Set<Listener>; matches: boolean }>();

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (media: string): MediaQueryList => {
    const entry = { media, listeners: new Set<Listener>(), matches: matches(media) };
    queries.add(entry);
    return {
      get matches() {
        return matches(media);
      },
      media,
      onchange: null,
      addEventListener: (_type: string, listener: Listener) => entry.listeners.add(listener),
      removeEventListener: (_type: string, listener: Listener) => entry.listeners.delete(listener),
      addListener: (listener: Listener) => entry.listeners.add(listener),
      removeListener: (listener: Listener) => entry.listeners.delete(listener),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  },
});

/** Sets the window width; queries whose answer changes notify their listeners (inside `act`). */
export function resizeTo(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  act(() => {
    for (const entry of queries) {
      const now = matches(entry.media);
      if (now !== entry.matches) {
        entry.matches = now;
        entry.listeners.forEach((listener) => listener({ matches: now, media: entry.media }));
      }
    }
  });
}

/** Back to jsdom's default width with no listeners (after each test). */
export function resetMedia(): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
  queries.clear();
}
