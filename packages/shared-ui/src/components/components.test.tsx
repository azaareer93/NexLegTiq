import { ArrowLeftOutlined } from '@ant-design/icons';
import type { Locale } from '@nexlegtiq/shared-types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { theme } from 'antd';
import type { ReactNode } from 'react';

import { FONT_FAMILY, nexTheme } from '../theme';
import { AiDisclaimer } from './AiDisclaimer/AiDisclaimer';
import { Bdi, Ltr } from './Bidi/Bidi';
import { ConfirmModal } from './ConfirmModal/ConfirmModal';
import { DirectionalIcon } from './DirectionalIcon/DirectionalIcon';
import { NexProvider } from './NexProvider';
import { PageHeader } from './PageHeader/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from './States/States';
import { PriorityTag, StatusTag } from './StatusTag/StatusTag';

const inLocale = (locale: Locale, ui: ReactNode) => render(<NexProvider userLocale={locale}>{ui}</NexProvider>);

describe('nexTheme', () => {
  it('should apply the brand tokens and the Arabic typography in Arabic only', () => {
    const ar = nexTheme('ar').token;
    const en = nexTheme('en').token;
    expect(ar).toMatchObject({ colorPrimary: '#1a3c6e', borderRadius: 8, controlHeight: 40, fontSize: 15, lineHeight: 1.8 });
    expect(ar?.fontFamily).toBe(FONT_FAMILY.ar);
    expect(en).toMatchObject({ fontSize: 14, fontFamily: FONT_FAMILY.en });
    expect(FONT_FAMILY.ar).toContain("'IBM Plex Sans Arabic'");
  });
});

describe('NexProvider', () => {
  function Token(): React.JSX.Element {
    const { token } = theme.useToken();
    return (
      <span data-testid="token">
        {token.fontSize}|{token.colorPrimary}
      </span>
    );
  }

  it.each([
    ['ar', '15|#1a3c6e'],
    ['en', '14|#1a3c6e'],
  ] as const)('should give AntD the NexLegTiq theme in %s', (locale, expected) => {
    inLocale(locale, <Token />);
    expect(screen.getByTestId('token').textContent).toBe(expected);
  });
});

describe('DirectionalIcon', () => {
  it.each([
    ['ar', 'scaleX(-1)'],
    ['en', ''],
  ] as const)('should mirror only in right-to-left (%s)', (locale, transform) => {
    inLocale(locale, <DirectionalIcon icon={ArrowLeftOutlined} data-testid="icon" />);
    expect(screen.getByTestId('icon').style.transform).toBe(transform);
  });
});

describe('StatusTag and PriorityTag', () => {
  it('should show an icon with the text, never colour alone', () => {
    inLocale('en', <StatusTag tone="error">Conflict</StatusTag>);
    const tag = screen.getByText('Conflict').closest('.ant-tag');
    expect(tag?.querySelector('.anticon')).not.toBeNull();
  });

  it.each([
    ['ar', 'عاجلة'],
    ['en', 'Urgent'],
  ] as const)('should label the priority in %s', (locale, label) => {
    inLocale(locale, <PriorityTag priority="URGENT" />);
    expect(screen.getByText(label).closest('.ant-tag')?.querySelector('.anticon-thunderbolt')).not.toBeNull();
  });
});

describe('states', () => {
  it('should default the empty state text and show the action', () => {
    inLocale('en', <EmptyState action={<button type="button">New</button>} />);
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
  });

  it('should explain the error code, show the request id left to right and retry', () => {
    const onRetry = vi.fn();
    inLocale('ar', <ErrorState code="RES-001" requestId="req-12345678" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('تعذّر العثور على المطلوب.');
    expect(screen.getByText('req-12345678').getAttribute('dir')).toBe('ltr');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('should show a generic error without a code, and no retry without a handler', () => {
    inLocale('en', <ErrorState />);
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('should announce loading', () => {
    inLocale('ar', <LoadingSkeleton />);
    expect(screen.getByRole('status').getAttribute('aria-label')).toBe('جارٍ التحميل…');
  });
});

describe('PageHeader', () => {
  it('should render the title, subtitle, actions and a labelled back button', () => {
    const onBack = vi.fn();
    inLocale('en', <PageHeader title="Case" subtitle="2026-LIT-00001" extra={<button type="button">Save</button>} onBack={onBack} />);
    expect(screen.getByRole('heading', { name: 'Case' })).toBeTruthy();
    expect(screen.getByText('2026-LIT-00001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('should leave out the back button without a handler', () => {
    inLocale('en', <PageHeader title="Case" />);
    expect(screen.queryByTestId('page-back')).toBeNull();
  });
});

describe('ConfirmModal', () => {
  it('should confirm or cancel with translated buttons', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    inLocale(
      'ar',
      <ConfirmModal open danger title="حذف" onConfirm={onConfirm} onCancel={onCancel}>
        نص
      </ConfirmModal>,
    );
    const ok = screen.getByTestId('confirm-ok');
    expect(ok.textContent).toBe('تأكيد');
    expect(ok.className).toContain('ant-btn-dangerous');
    act(() => ok.click());
    act(() => screen.getByTestId('confirm-cancel').click());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe('Ltr, Bdi and AiDisclaimer', () => {
  it('should isolate left-to-right and unknown-direction text', () => {
    inLocale(
      'ar',
      <>
        <Ltr>050-123-4567</Ltr>
        <Bdi>Omar</Bdi>
      </>,
    );
    expect(screen.getByText('050-123-4567').getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('Omar').tagName).toBe('BDI');
  });

  it('should show the AI disclaimer in the user language', () => {
    inLocale('en', <AiDisclaimer />);
    expect(screen.getByTestId('ai-disclaimer').textContent).toContain('may contain mistakes');
  });
});
