import { ArrowLeftOutlined, ArrowRightOutlined } from '@ant-design/icons';
import type { Locale } from '@nexlegtiq/shared-types';
import { fireEvent, render, screen } from '@testing-library/react';
import { theme } from 'antd';
import dayjs from 'dayjs';
import type { ReactNode } from 'react';

import { BRAND, FONT_FAMILY, nexTheme } from '../theme';
import fontsSource from '../theme/fonts.ts?raw';
import { AiDisclaimer } from './AiDisclaimer/AiDisclaimer';
import { Bdi, Ltr } from './Bidi/Bidi';
import { ConfirmModal } from './ConfirmModal/ConfirmModal';
import { DirectionalIcon } from './DirectionalIcon/DirectionalIcon';
import { NexProvider } from './NexProvider';
import { PageHeader } from './PageHeader/PageHeader';
import { EmptyState, ErrorState, LoadingSkeleton } from './States/States';
import { PriorityTag, StatusTag } from './StatusTag/StatusTag';

const inLocale = (locale: Locale, ui: ReactNode) => render(<NexProvider userLocale={locale}>{ui}</NexProvider>);

afterEach(() => {
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
  dayjs.locale('en');
  vi.restoreAllMocks();
});

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(first: string, second: string): number {
  const channel = (hex: string, at: number) => {
    const value = parseInt(hex.slice(at, at + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string) => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
  const [a, b] = [luminance(first), luminance(second)];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('nexTheme', () => {
  it('should apply the brand tokens and the Arabic typography in Arabic only', () => {
    const ar = nexTheme('ar').token;
    const en = nexTheme('en').token;
    expect(ar).toMatchObject({ colorPrimary: '#1a3c6e', borderRadius: 8, controlHeight: 40, fontSize: 15, lineHeight: 1.8 });
    expect(ar?.fontFamily).toBe(FONT_FAMILY.ar);
    expect(en).toMatchObject({ fontSize: 14, fontFamily: FONT_FAMILY.en });
    expect(FONT_FAMILY.ar).toContain("'IBM Plex Sans Arabic'");
  });

  it('should keep the page grey behind white inputs and cards', () => {
    expect(nexTheme('en').token).toMatchObject({ colorBgLayout: '#f8f9fa', colorBgContainer: '#ffffff' });
  });

  it.each([
    ['text on white', BRAND.text, BRAND.bgBase],
    ['text on the page grey', BRAND.text, BRAND.bgLayout],
    ['secondary text on white', BRAND.textSecondary, BRAND.bgBase],
    ['secondary text on the page grey', BRAND.textSecondary, BRAND.bgLayout],
    ['primary links on white', BRAND.primary, BRAND.bgBase],
    ['white text on primary buttons', BRAND.bgBase, BRAND.primary],
  ])('should give %s at least WCAG AA contrast (4.5:1)', (_case, foreground, background) => {
    expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5);
  });

  it('should load fonts only from the bundled @fontsource packages, never a CDN', () => {
    const imports = [...fontsSource.matchAll(/import '([^']+)'/g)].map((match) => match[1] ?? '');
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.filter((path) => !/^@fontsource(-variable)?\//.test(path))).toEqual([]);
    expect(fontsSource).not.toMatch(/https?:\/\//);
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

  it('should keep a transform the caller set', () => {
    inLocale('ar', <DirectionalIcon icon={ArrowLeftOutlined} style={{ transform: 'rotate(90deg)' }} data-testid="icon" />);
    expect(screen.getByTestId('icon').style.transform).toBe('rotate(90deg) scaleX(-1)');
  });
});

describe('StatusTag and PriorityTag', () => {
  it('should show a hidden-from-screen-readers icon with the text, never colour alone', () => {
    inLocale('en', <StatusTag tone="error">Conflict</StatusTag>);
    const tag = screen.getByText('Conflict').closest('.ant-tag');
    expect(tag?.querySelector('.anticon-close-circle')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('should use a custom icon instead of the tone icon', () => {
    inLocale(
      'en',
      <StatusTag tone="error" icon={ArrowRightOutlined}>
        Moved
      </StatusTag>,
    );
    const tag = screen.getByText('Moved').closest('.ant-tag');
    expect(tag?.querySelector('.anticon-arrow-right')).not.toBeNull();
    expect(tag?.querySelector('.anticon-close-circle')).toBeNull();
  });

  it.each([
    ['ar', 'عاجلة'],
    ['en', 'Urgent'],
  ] as const)('should label the priority in %s', (locale, label) => {
    inLocale(locale, <PriorityTag priority="URGENT" />);
    expect(screen.getByText(label).closest('.ant-tag')?.querySelector('.anticon-thunderbolt')).not.toBeNull();
  });

  it.each([
    ['LOW', 'منخفضة', 'arrow-down'],
    ['MEDIUM', 'متوسطة', 'minus'],
    ['HIGH', 'مرتفعة', 'arrow-up'],
  ] as const)('should show %s with its own label and icon', (priority, label, icon) => {
    inLocale('ar', <PriorityTag priority={priority} />);
    expect(screen.getByText(label).closest('.ant-tag')?.querySelector(`.anticon-${icon}`)).not.toBeNull();
  });
});

describe('states', () => {
  it('should default the empty state text and show the action', () => {
    inLocale('en', <EmptyState action={<button type="button">New</button>} />);
    expect(screen.getByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'New' })).toBeTruthy();
  });

  it('should show a custom empty title and description', () => {
    inLocale('en', <EmptyState title="No cases" description="Create the first one" />);
    expect(screen.getByText('No cases')).toBeTruthy();
    expect(screen.getByText('Create the first one')).toBeTruthy();
  });

  it('should explain the error code, show the request id left to right and retry', () => {
    const onRetry = vi.fn();
    inLocale('ar', <ErrorState code="RES-001" requestId="req-12345678" onRetry={onRetry} />);
    expect(screen.getByRole('alert').textContent).toContain('تعذّر العثور على المطلوب.');
    expect(screen.getByRole('alert').textContent).toContain('رقم المرجع:');
    expect(screen.getByText('req-12345678').getAttribute('dir')).toBe('ltr');
    fireEvent.click(screen.getByRole('button', { name: 'إعادة المحاولة' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('should show the generic message for an error code this version does not know, never the raw code', () => {
    inLocale('en', <ErrorState code={'ZZZ-999' as never} />);
    expect(screen.getByRole('alert').textContent).toContain('Something went wrong');
    expect(screen.getByRole('alert').textContent).not.toContain('ZZZ-999');
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
  it('should render the title as the page heading, the subtitle, actions and a labelled back button', () => {
    const onBack = vi.fn();
    inLocale('en', <PageHeader title="Case" subtitle="2026-LIT-00001" extra={<button type="button">Save</button>} onBack={onBack} />);
    expect(screen.getByRole('heading', { name: 'Case', level: 1 })).toBeTruthy();
    expect(screen.getByText('2026-LIT-00001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('should leave out the back button without a handler, and take another heading level', () => {
    inLocale('en', <PageHeader title="Documents" level={2} />);
    expect(screen.queryByTestId('page-back')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Documents', level: 2 })).toBeTruthy();
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
    fireEvent.click(ok);
    fireEvent.click(screen.getByTestId('confirm-cancel'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should show progress and not close while the action runs', () => {
    const onCancel = vi.fn();
    inLocale('en', <ConfirmModal open loading title="Delete" confirmText="Delete" onConfirm={() => undefined} onCancel={onCancel} />);
    expect(screen.getByTestId('confirm-ok').className).toContain('ant-btn-loading');
    expect(screen.getByTestId('confirm-ok').textContent).toContain('Delete');
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.querySelector('.ant-modal-close')).toBeNull();
  });

  it('should render nothing while closed', () => {
    inLocale('en', <ConfirmModal open={false} title="Delete" onConfirm={() => undefined} onCancel={() => undefined} />);
    expect(screen.queryByRole('dialog')).toBeNull();
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
    expect(screen.getByTestId('ai-disclaimer').textContent).toContain('must be reviewed and verified by a lawyer');
  });
});
