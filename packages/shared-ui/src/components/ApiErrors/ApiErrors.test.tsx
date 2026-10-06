import type { Locale } from '@nexlegtiq/shared-types';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import { notification } from 'antd';
import type { FormInstance } from 'antd';
import type { ReactNode } from 'react';

import { NexProvider } from '../NexProvider';
import { ApiErrorAlert, isApiError, useApiErrorHandler } from './ApiErrors';

const REQUEST_ID = '0192f0aa-77c1-7c3e-9a51-2b3c4d5e6f70';
const OTHER_ID = '0192f0aa-77c1-7c3e-9a51-000000000002';
const AUTH_001_EN = 'The email or password is incorrect.';

afterEach(() => {
  // Notifications live in a container outside the rendered tree: clear them so no test sees another one's.
  act(() => notification.destroy());
  cleanup();
  document.documentElement.removeAttribute('dir');
  document.documentElement.removeAttribute('lang');
});

const wrapperFor =
  (locale: Locale) =>
  ({ children }: { children: ReactNode }) => <NexProvider userLocale={locale}>{children}</NexProvider>;

const handlerIn = (locale: Locale) => renderHook(() => useApiErrorHandler(), { wrapper: wrapperFor(locale) }).result.current;

describe('isApiError', () => {
  it.each([
    [{ code: 'AUTH-001' }, true],
    [{ code: 'ZZZ-999' }, true], // shaped like a code: shown as the generic message
    [{ code: 'ERR_NETWORK' }, false], // an axios code, never shown
    [new Error('boom'), false],
    [null, false],
    ['SYS-001', false],
  ])('%j → %s', (value, expected) => {
    expect(isApiError(value)).toBe(expected);
  });
});

describe('useApiErrorHandler', () => {
  it('should map a code to its message in the user language, and anything else to the generic message', () => {
    const en = handlerIn('en');
    expect(en.messageOf({ code: 'AUTH-001' })).toBe(AUTH_001_EN);
    expect(en.messageOf({ code: 'ZZZ-999' })).toBe('Something went wrong');
    expect(en.messageOf(new Error('secret stack trace'))).toBe('Something went wrong');
    expect(handlerIn('ar').messageOf({ code: 'AUTH-001' })).toBe('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
  });

  it('should say how long to wait, with Arabic number agreement, only for a known code', () => {
    expect(handlerIn('en').messageOf({ code: 'RATE-001', retryAfter: 1 })).toMatch(/Try again in 1 second\.$/);
    expect(handlerIn('ar').messageOf({ code: 'RATE-001', retryAfter: 2 })).toMatch(/بعد ثانيتين\.$/);
    expect(handlerIn('en').messageOf({ code: 'ZZZ-999', retryAfter: 5 })).toBe('Something went wrong');
  });

  it('should give a support reference only for failures the user cannot fix', () => {
    const { referenceOf } = handlerIn('en');
    expect(referenceOf({ code: 'SYS-001', requestId: REQUEST_ID })).toBe(REQUEST_ID);
    expect(referenceOf({ code: 'AI-004', requestId: REQUEST_ID })).toBe(REQUEST_ID);
    expect(referenceOf({ code: 'ZZZ-999', requestId: REQUEST_ID })).toBe(REQUEST_ID);
    expect(referenceOf({ code: 'AUTH-001', requestId: REQUEST_ID })).toBeUndefined();
    expect(referenceOf({ code: 'SYS-001' })).toBeUndefined();
  });

  it('should put field errors on their fields and tell whether they explain everything', () => {
    const setFields = vi.fn();
    const form = { setFields } as unknown as FormInstance;
    const { applyToForm, translateKey } = handlerIn('en');
    const email = { field: 'email', message: 'validation.email' };
    const onEmail = [{ name: 'email', errors: [translateKey('validation.email')] }];
    expect(applyToForm(form, { code: 'VAL-001', details: [email] }, ['email'])).toBe(true);
    expect(setFields).toHaveBeenLastCalledWith(onEmail);
    // A detail for a field the form does not show: the matching one is still set, and the banner must explain the rest.
    expect(applyToForm(form, { code: 'VAL-001', details: [email, { field: 'other', message: 'validation.required' }] }, ['email'])).toBe(false);
    expect(setFields).toHaveBeenLastCalledWith(onEmail);
    expect(applyToForm(form, new Error('x'), ['email'])).toBe(false);
    expect(translateKey('validation.nope')).toBe('Something went wrong');
  });

  it('should keep the same handler between renders', () => {
    const { result, rerender } = renderHook(() => useApiErrorHandler(), { wrapper: wrapperFor('en') });
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });

  it('should notify a server failure with its reference left to right, in Arabic too', async () => {
    const { result } = renderHook(() => useApiErrorHandler(), { wrapper: wrapperFor('ar') });
    act(() => result.current.notify({ code: 'SYS-001', requestId: REQUEST_ID }));
    expect((await screen.findByText(REQUEST_ID)).getAttribute('dir')).toBe('ltr');
    expect(document.body.textContent).toContain('المرجع');
  });

  it('should notify a failure the user can fix without a reference', async () => {
    const { result } = renderHook(() => useApiErrorHandler(), { wrapper: wrapperFor('en') });
    act(() => result.current.notify({ code: 'AUTH-001', requestId: OTHER_ID }));
    expect(await screen.findByText(AUTH_001_EN)).toBeTruthy();
    expect(screen.queryByText(OTHER_ID)).toBeNull();
  });

  it('should still notify outside AntD App instead of throwing', async () => {
    const { result } = renderHook(() => useApiErrorHandler());
    act(() => result.current.notify({ code: 'ZZZ-999' }));
    await waitFor(() => expect(document.querySelector('.ant-notification-notice')).not.toBeNull());
  });
});

describe('ApiErrorAlert', () => {
  it.each([
    ['no error', null],
    ['an error its fields explain', { code: 'VAL-001', details: [{ field: 'email', message: 'validation.email' }] }],
  ])('should show nothing for %s', (_case, error) => {
    const { container } = render(<ApiErrorAlert error={error} fields={['email']} />, { wrapper: wrapperFor('en') });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('should show the message and, for a server failure, the reference left to right', () => {
    render(<ApiErrorAlert error={{ code: 'SYS-001', requestId: REQUEST_ID }} testId="alert" />, { wrapper: wrapperFor('ar') });
    const alert = screen.getByTestId('alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('المرجع');
    expect(screen.getByText(REQUEST_ID).getAttribute('dir')).toBe('ltr');
  });

  it('should show the generic message and the reference for a code this build does not know, with its action', () => {
    render(<ApiErrorAlert error={{ code: 'ZZZ-999', requestId: REQUEST_ID }} action={<button type="button">act</button>} testId="alert" />, {
      wrapper: wrapperFor('en'),
    });
    const alert = screen.getByTestId('alert');
    expect(alert.textContent).toContain('Something went wrong');
    expect(alert.textContent).toContain(REQUEST_ID);
    expect(screen.getByRole('button', { name: 'act' })).toBeTruthy();
  });
});
