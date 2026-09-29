import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';

import { APP_NAME } from './app-name';
import { routes } from './routes';

describe('routes', () => {
  it('should render the placeholder home page at /', async () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/'] });

    render(<RouterProvider router={router} />);

    expect(await screen.findByTestId('home-page')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(APP_NAME);
  });

  it('should be named NexLegTiq Admin', () => {
    expect(APP_NAME).toBe('NexLegTiq Admin');
  });
});
