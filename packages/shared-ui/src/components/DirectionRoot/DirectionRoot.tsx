import type { Locale } from '@nexlegtiq/shared-types';
import { textDirectionOf } from '@nexlegtiq/shared-utils';
import type { ReactNode } from 'react';

export interface DirectionRootProps {
  readonly locale: Locale;
  readonly children: ReactNode;
}

/**
 * Wraps content with the `dir`/`lang` of the active locale. Does not reach portals (AntD modals/popovers render
 * outside this element) — the LanguageProvider (MVP-44) sets `<html dir lang>` and supersedes it.
 */
export function DirectionRoot({ locale, children }: DirectionRootProps): React.JSX.Element {
  return (
    <div dir={textDirectionOf(locale)} lang={locale}>
      {children}
    </div>
  );
}
