import '../../theme/fonts';

import { App, ConfigProvider } from 'antd';
import { useMemo } from 'react';
import type { ReactNode } from 'react';

import { nexTheme } from '../../theme';
import { FormatSettingsProvider } from '../Format/Format';
import type { FormatSettings } from '../Format/Format';
import { LanguageProvider, useLanguage } from '../LanguageProvider';
import type { LanguageProviderProps } from '../LanguageProvider';

export type NexProviderProps = LanguageProviderProps & FormatSettings;

/**
 * The root of every NexLegTiq app: language and direction (`LanguageProvider`), the time zone and digits `useFormat` uses,
 * the NexLegTiq AntD theme for that language
 * (Arabic gets its font, +1px and line-height 1.8) and AntD's `App` context, so `message`, `notification` and `modal`
 * follow the theme and direction too.
 */
export function NexProvider({
  children,
  timeZone,
  digits,
  ...language
}: NexProviderProps): React.JSX.Element {
  return (
    <LanguageProvider {...language}>
      <FormatSettingsProvider timeZone={timeZone} digits={digits}>
        <ThemedApp>{children}</ThemedApp>
      </FormatSettingsProvider>
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
