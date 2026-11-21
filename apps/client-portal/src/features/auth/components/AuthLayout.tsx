import { OfflineBanner } from '@nexlegtiq/shared-ui';
import { Card, Flex, Layout, Typography } from 'antd';
import type { ReactNode } from 'react';

import { APP_NAME } from '../../../app/app-name';
import { LanguageSwitch } from '../../shell/LanguageSwitch';

/** The card of the sign-in, invitation and password pages: full width on a phone, centred on a larger screen. */
export function AuthLayout({
  title,
  subtitle,
  children,
}: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly children: ReactNode;
}): React.JSX.Element {
  return (
    <Layout style={{ minBlockSize: '100vh' }}>
      <OfflineBanner />
      <Layout.Content>
        <Flex
          vertical
          align="center"
          gap={16}
          style={{ minBlockSize: '100vh', paddingBlock: 24, paddingInline: 16 }}
        >
          <Flex
            justify="space-between"
            align="center"
            style={{ inlineSize: '100%', maxInlineSize: 480 }}
          >
            {/* The product name is a brand, not translated. */}
            <Typography.Text strong style={{ fontSize: 18 }}>
              {APP_NAME}
            </Typography.Text>
            <LanguageSwitch />
          </Flex>
          <Card style={{ inlineSize: '100%', maxInlineSize: 480 }}>
            <Flex vertical gap={4} style={{ marginBlockEnd: 24 }}>
              <Typography.Title level={1} style={{ margin: 0, fontSize: 22 }}>
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
