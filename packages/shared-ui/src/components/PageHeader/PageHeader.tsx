import { ArrowLeftOutlined } from '@ant-design/icons';
import { Button, Flex, theme, Typography } from 'antd';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { DirectionalIcon } from '../DirectionalIcon/DirectionalIcon';

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  /** Page actions, at the end of the row (left in Arabic, right in English). */
  readonly extra?: ReactNode;
  /** Shows a back button pointing the reading direction's "back". */
  readonly onBack?: () => void;
  /** Heading level; default 1 (the page's main heading). The size stays the same. */
  readonly level?: 1 | 2 | 3;
}

/** The title row of a page: optional back button, title and subtitle, actions. */
export function PageHeader({
  title,
  subtitle,
  extra,
  onBack,
  level = 1,
}: PageHeaderProps): React.JSX.Element {
  const { t } = useTranslation();
  const { token } = theme.useToken();
  return (
    <Flex component="header" align="center" gap={16} wrap style={{ marginBlockEnd: 24 }}>
      {onBack ? (
        <Button
          type="text"
          icon={<DirectionalIcon icon={ArrowLeftOutlined} />}
          aria-label={t('common.actions.back')}
          onClick={onBack}
          data-testid="page-back"
        />
      ) : null}
      <Flex vertical style={{ flex: '1 1 auto', minInlineSize: 0 }}>
        <Typography.Title
          level={level}
          style={{ marginBlock: 0, fontSize: token.fontSizeHeading3 }}
        >
          {title}
        </Typography.Title>
        {subtitle ? <Typography.Text type="secondary">{subtitle}</Typography.Text> : null}
      </Flex>
      {extra ? (
        <Flex gap={8} wrap>
          {extra}
        </Flex>
      ) : null}
    </Flex>
  );
}
