import '../../theme/fonts';

import { App, ConfigProvider } from 'antd';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { nexTheme } from '../../theme';
import { LanguageProvider, useLanguage } from '../LanguageProvider';
import type { LanguageProviderProps } from '../LanguageProvider';

export type NexProviderProps = LanguageProviderProps;

/**
 * The root of every NexLegTiq app: language and direction (`LanguageProvider`), the NexLegTiq AntD theme for that language
 * (Arabic gets its font, +1px and line-height 1.8) and AntD's `App` context, so `message`, `notification` and `modal`
 * follow the theme and direction too.
 */
export function NexProvider({ children, ...language }: NexProviderProps): React.JSX.Element {
  return (
    <LanguageProvider {...language}>
      <ThemedApp>{children}</ThemedApp>
    </LanguageProvider>
  );
}

function ThemedApp({ children }: { readonly children: ReactNode }): React.JSX.Element {
  const { locale } = useLanguage();
  const theme = useMemo(() => nexTheme(locale), [locale]);
  return (
    <ConfigProvider theme={theme}>
      <App>{children}</App>
    </ConfigProvider>
  );
}
