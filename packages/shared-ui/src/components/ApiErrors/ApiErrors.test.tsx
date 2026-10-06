import type { Locale } from '@nexlegtiq/shared-types';
import { act, cleanup, render, renderHook, screen, waitFor } from '@testing-library/react';
import type { FormInstance } from 'antd';
import type { ReactNode } from 'react';

import { NexProvider } from '../NexProvider';
import { ApiErrorAlert, isApiError, OfflineBanner, useApiErrorHandler } from './ApiErrors';

const REQUEST_ID = '0192f0aa-77c1-7c3e-9a51-2b3c4d5e6f70';

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'onLine');
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
    expect(en.messageOf({ code: 'AUTH-001' })).toBe('The email or password is incorrect.');
    expect(en.messageOf({ code: 'ZZZ-999' })).toBe('Something went wrong');
    expect(en.messageOf(new Error('secret stack trace'))).toBe('Something went wrong');
    expect(handlerIn('ar').messageOf({ code: 'AUTH-001' })).toBe('البريد الإلكتروني أو كلمة المرور غير صحيحة.');
  });

  it('should say how long to wait, with Arabic number agreement', () => {
    expect(handlerIn('en').messageOf({ code: 'RATE-001', retryAfter: 1 })).toMatch(/Try again in 1 second\.$/);
    expect(handlerIn('ar').messageOf({ code: 'RATE-001', retryAfter: 2 })).toMatch(/بعد ثانيتين\.$/);
  });

  it('should give a support reference only for failures the user cannot fix', () => {
    const { referenceOf } = handlerIn('en');
    expect(referenceOf({ code: 'SYS-001', requestId: REQUEST_ID })).toBe(REQUEST_ID);
    expect(referenceOf({ code: 'ZZZ-999', requestId: REQUEST_ID })).toBe(REQUEST_ID);
    expect(referenceOf({ code: 'AUTH-001', requestId: REQUEST_ID })).toBeUndefined();
    expect(referenceOf({ code: 'SYS-001' })).toBeUndefined();
  });

  it('should put field errors on their fields and tell whether they explain everything', () => {
    const setFields = vi.fn();
    const form = { setFields } as unknown as FormInstance;
    const { applyToForm, translateKey } = handlerIn('en');
    const error = { code: 'VAL-001', details: [{ field: 'email', message: 'validation.email' }] };
    expect(applyToForm(form, error, ['email'])).toBe(true);
    expect(setFields).toHaveBeenCalledWith([{ name: 'email', errors: [translateKey('validation.email')] }]);
    expect(applyToForm(form, { ...error, details: [{ field: 'other', message: 'validation.email' }] }, ['email'])).toBe(false);
    expect(applyToForm(form, new Error('x'), ['email'])).toBe(false);
    expect(translateKey('validation.nope')).toBe('Something went wrong');
  });

  it('should notify a failed action with its reference', async () => {
    const { result } = renderHook(() => useApiErrorHandler(), { wrapper: wrapperFor('en') });
    act(() => result.current.notify({ code: 'SYS-001', requestId: REQUEST_ID }));
    expect(await screen.findByText(REQUEST_ID)).toBeTruthy();
    act(() => result.current.notify({ code: 'AUTH-001', requestId: REQUEST_ID }));
    expect(await screen.findByText('The email or password is incorrect.')).toBeTruthy();
  });
});

describe('ApiErrorAlert', () => {
  it('should show nothing without an error, or when the fields explain it', () => {
    const { container } = render(<ApiErrorAlert error={{ code: 'VAL-001', details: [{ field: 'email', message: 'validation.email' }] }} fields={['email']} />, {
      wrapper: wrapperFor('en'),
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('should show the message and, for a server failure, the reference left to right', () => {
    render(<ApiErrorAlert error={{ code: 'SYS-001', requestId: REQUEST_ID }} testId="alert" />, { wrapper: wrapperFor('ar') });
    const alert = screen.getByTestId('alert');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(screen.getByText(REQUEST_ID).getAttribute('dir')).toBe('ltr');
  });
});

describe('OfflineBanner', () => {
  it('should appear while offline and go when the connection is back', async () => {
    render(<OfflineBanner />, { wrapper: wrapperFor('en') });
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    act(() => void window.dispatchEvent(new Event('offline')));
    expect(screen.getByTestId('offline-banner').textContent).toContain("You're offline");
    Reflect.deleteProperty(navigator, 'onLine');
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(screen.queryByTestId('offline-banner')).toBeNull());
  });
});
