import { BugOutlined, MailOutlined, MessageOutlined } from '@ant-design/icons';
import { PageHeader } from '@nexlegtiq/shared-ui';
import { Button, Card, Flex, List, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { ShortcutList } from '../../shell';
import { bugReportHref, HELP_ARTICLES, HELP_SLUGS, SUPPORT } from '../articles';

function Contact() {
  const { t, i18n } = useTranslation();
  if (!SUPPORT.email && !SUPPORT.whatsapp) {
    return <Typography.Text type="secondary">{t('help.contact.none')}</Typography.Text>;
  }
  return (
    <Flex vertical gap={8} align="start">
      {SUPPORT.email ? (
        <Button icon={<MailOutlined />} href={`mailto:${SUPPORT.email}`} data-testid="help-email">
          {t('help.contact.email')}
        </Button>
      ) : null}
      {SUPPORT.whatsapp ? (
        <Button
          icon={<MessageOutlined />}
          href={`https://wa.me/${SUPPORT.whatsapp}`}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="help-whatsapp"
        >
          {t('help.contact.whatsapp')}
        </Button>
      ) : null}
      {SUPPORT.email ? (
        <Button
          icon={<BugOutlined />}
          href={bugReportHref(SUPPORT.email, t('help.contact.bugSubject'), i18n.language)}
          data-testid="help-bug"
        >
          {t('help.contact.bug')}
        </Button>
      ) : null}
    </Flex>
  );
}

/** `/help` (MVP-119, D-185): the guides, keyboard shortcuts and how to reach support. */
export function HelpPage() {
  const { t } = useTranslation();
  return (
    <section data-testid="page-help">
      <PageHeader title={t('help.title')} subtitle={t('help.subtitle')} />
      <Flex gap={16} wrap align="start">
        <Card title={t('help.guides')} style={{ flex: '2 1 420px' }}>
          <List
            dataSource={HELP_SLUGS}
            data-testid="help-articles"
            renderItem={(slug) => (
              <List.Item>
                <List.Item.Meta
                  title={
                    <Link to={`/help/${slug}`} data-testid={`help-article-${slug}`}>
                      {t(`help.articles.${HELP_ARTICLES[slug]}.title`)}
                    </Link>
                  }
                  description={t(`help.articles.${HELP_ARTICLES[slug]}.summary`)}
                />
              </List.Item>
            )}
          />
        </Card>
        <Flex vertical gap={16} style={{ flex: '1 1 260px' }}>
          <Card title={t('help.contact.title')} data-testid="help-contact">
            <Contact />
          </Card>
          <Card title={t('help.shortcuts.title')}>
            <ShortcutList />
          </Card>
        </Flex>
      </Flex>
    </section>
  );
}
