import { canvasRenderer, MAX_CANVAS_PIXELS } from './pdf-render';

/** A page whose render resolves at once and records which page drew. */
function fakePdf() {
  const drawn: number[] = [];
  const pending: { number: number; resolve: () => void }[] = [];
  const page = (number: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => {
      drawn.push(number);
      return { promise: Promise.resolve(), cancel: vi.fn() };
    },
  });
  const pdf = {
    getPage: (number: number) =>
      new Promise((resolve) => {
        pending.push({ number, resolve: () => resolve(page(number)) });
      }),
  };
  return { pdf: pdf as never, drawn, pending };
}

describe('canvasRenderer (D-143)', () => {
  it('should draw only the latest page when pages are asked for faster than they load', async () => {
    const { pdf, drawn, pending } = fakePdf();
    const render = canvasRenderer(pdf);
    const canvas = document.createElement('canvas');
    const first = render(1, canvas, 300);
    const second = render(2, canvas, 300);
    // The second page loads first, then the first one: the first must not draw over it.
    pending[1]?.resolve();
    await second;
    pending[0]?.resolve();
    await first;
    expect(drawn).toEqual([2]);
    expect(canvas.style.width).toBe('300px');
  });

  it('should treat a render cancelled by a newer one as no failure, and rethrow anything else', async () => {
    const canvas = document.createElement('canvas');
    const page = (error: Error) => ({
      getViewport: () => ({ width: 100, height: 100 }),
      render: () => ({ promise: Promise.reject(error), cancel: vi.fn() }),
    });
    const cancelled = Object.assign(new Error('cancelled'), {
      name: 'RenderingCancelledException',
    });
    await expect(
      canvasRenderer({ getPage: () => Promise.resolve(page(cancelled)) } as never)(1, canvas, 100),
    ).resolves.toBeUndefined();
    await expect(
      canvasRenderer({ getPage: () => Promise.resolve(page(new Error('broken'))) } as never)(
        1,
        canvas,
        100,
      ),
    ).rejects.toThrow('broken');
  });

  it('should cap the canvas of a hostile page shape at MAX_CANVAS_PIXELS', async () => {
    const canvas = document.createElement('canvas');
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 1 * scale, height: 14_400 * scale }),
      render: () => ({ promise: Promise.resolve(), cancel: vi.fn() }),
    };
    await canvasRenderer({ getPage: () => Promise.resolve(page) } as never)(1, canvas, 800);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(canvas.style.width).toBe('800px');
  });
});
