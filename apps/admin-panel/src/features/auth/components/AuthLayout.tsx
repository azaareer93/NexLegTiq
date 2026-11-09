import { isLocale } from '@nexlegtiq/shared-types';
import { OfflineBanner, useLanguage } from '@nexlegtiq/shared-ui';
import { Card, Flex, Layout, Segmented, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { APP_NAME } from '../../../app/app-name';

/** The centred card of the sign-in and enrolment pages, with the product name and the AR | EN switch. */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  const { t } = useTranslation();
  const { locale, setLocale } = useLanguage();
  return (
    <Layout style={{ minBlockSize: '100vh' }}>
      <OfflineBanner />
      <Layout.Content>
        <Flex
          vertical
          align="center"
          justify="center"
          gap={16}
          style={{ minBlockSize: '100vh', paddingBlock: 32, paddingInline: 16 }}
        >
          <Flex
            justify="space-between"
            align="center"
            style={{ inlineSize: '100%', maxInlineSize: 480 }}
          >
            {/* The product name is a brand, not translated. */}
            <Typography.Text strong style={{ fontSize: 20 }}>
              {APP_NAME}
            </Typography.Text>
            <Segmented
              aria-label={t('common.language.label')}
              data-testid="language-switch"
              size="small"
              value={locale}
              onChange={(value) => isLocale(value) && setLocale(value)}
              options={[
                { value: 'ar', label: <span lang="ar">{t('common.language.ar')}</span> },
                { value: 'en', label: <span lang="en">{t('common.language.en')}</span> },
              ]}
            />
          </Flex>
          <Card style={{ inlineSize: '100%', maxInlineSize: 480 }}>
            <Flex vertical gap={4} style={{ marginBlockEnd: 24 }}>
              <Typography.Title level={1} style={{ margin: 0, fontSize: 24 }}>
                {title}
              </Typography.Title>
              {subtitle ? <Typography.Text type="secondary">{subtitle}</Typography.Text> : null}
            </Flex>
            {children}
          </Card>
        </Flex>
      </Layout.Content>
    </Layout>
  );
}
