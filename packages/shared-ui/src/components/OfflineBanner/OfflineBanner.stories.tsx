import type { Meta, StoryObj } from '@storybook/react-vite';
import { useLayoutEffect } from 'react';

import { OfflineBanner } from './OfflineBanner';

const meta = { title: 'Feedback/Offline banner', component: OfflineBanner } satisfies Meta<typeof OfflineBanner>;
export default meta;
type Story = StoryObj<typeof meta>;

/** The banner reads the browser's state: the story switches it off while shown and back on when it unmounts. */
function Offline(): React.JSX.Element {
  useLayoutEffect(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    // The stories' tsconfig has no DOM lib: the window is reached as the global event target.
    (globalThis as unknown as EventTarget).dispatchEvent(new Event('offline'));
    return () => {
      Reflect.deleteProperty(navigator, 'onLine');
      (globalThis as unknown as EventTarget).dispatchEvent(new Event('online'));
    };
  }, []);
  return <OfflineBanner />;
}

export const WhileOffline: Story = { render: () => <Offline /> };
