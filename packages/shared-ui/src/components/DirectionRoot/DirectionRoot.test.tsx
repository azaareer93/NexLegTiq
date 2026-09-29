import { render, screen } from '@testing-library/react';

import { DirectionRoot } from './DirectionRoot';

describe('DirectionRoot', () => {
  it('should render rtl for Arabic', () => {
    render(<DirectionRoot locale="ar">محتوى</DirectionRoot>);
    const root = screen.getByText('محتوى');
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(root.getAttribute('lang')).toBe('ar');
  });

  it('should render ltr for English', () => {
    render(<DirectionRoot locale="en">content</DirectionRoot>);
    expect(screen.getByText('content').getAttribute('dir')).toBe('ltr');
  });
});
