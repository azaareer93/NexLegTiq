import { NexProvider } from '@nexlegtiq/shared-ui';
import { cleanup, render, screen } from '@testing-library/react';

import { EntriesTable } from './components/EntriesTable';

const ENTRY = {
  id: '01920000-0000-7000-8000-000000000001',
  file: { id: '01920000-0000-7000-8000-0000000001f1', fileNumber: '2026-LIT-00007', title: 'T' },
  user: { id: '01920000-0000-7000-8000-0000000000a1', fullName: 'Sami Nasser' },
  workDate: '2026-11-08',
  durationHours: '1.50',
  description: 'Work 1',
  isBillable: true,
  hourlyRate: '150.00',
  amount: '225.00',
  currency: 'ILS',
  invoiced: false,
  createdAt: '2026-11-08T09:00:00.000Z',
  updatedAt: '2026-11-08T09:00:00.000Z',
};

const table = (showMoney: boolean) =>
  render(
    <NexProvider userLocale="en">
      <EntriesTable
        entries={[ENTRY]}
        total={1}
        page={1}
        onPage={() => undefined}
        showMoney={showMoney}
        canLog={false}
        onEdit={() => undefined}
        onDelete={() => undefined}
      />
    </NexProvider>,
  );

afterEach(cleanup);

describe('EntriesTable money columns', () => {
  it('should show rate and amount for invoice readers', () => {
    table(true);
    expect(screen.getAllByText('Rate').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Amount').length).toBeGreaterThan(0);
    expect(screen.getByText('₪225.00')).toBeTruthy();
  });

  it('should hide rate and amount without invoice rights', () => {
    table(false);
    expect(screen.queryByText('Rate')).toBeNull();
    expect(screen.queryByText('Amount')).toBeNull();
    expect(screen.queryByText('₪225.00')).toBeNull();
    expect(screen.getAllByText('Duration').length).toBeGreaterThan(0);
  });
});
