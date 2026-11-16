import { ArrowLeftOutlined } from '@ant-design/icons';
import { DirectionalIcon, PageHeader } from '@nexlegtiq/shared-ui';
import { Button, Card, Result, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router';

import { HELP_ARTICLES, isHelpSlug } from '../articles';

/** `/help/:slug`: one guide — paragraphs separated by blank lines, numbered steps one per line. */
export function HelpArticlePage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { slug } = useParams();
  const back = (
    <Button
      icon={<DirectionalIcon icon={ArrowLeftOutlined} />}
      onClick={() => void navigate('/help')}
      data-testid="help-back"
    >
      {t('help.back')}
    </Button>
  );
  if (!isHelpSlug(slug)) {
    return <Result status="404" title={t('help.notFound')} extra={back} />;
  }
  const key = HELP_ARTICLES[slug];
  const paragraphs = t(`help.articles.${key}.body`).split('\n\n');
  const steps = t(`help.articles.${key}.steps`).split('\n').filter(Boolean);
  return (
    <article data-testid="page-help-article">
      <PageHeader
        title={t(`help.articles.${key}.title`)}
        subtitle={t(`help.articles.${key}.summary`)}
        extra={back}
      />
      <Card>
        {paragraphs.map((p) => (
          <Typography.Paragraph key={p.slice(0, 40)}>{p}</Typography.Paragraph>
        ))}
        <ol data-testid="help-steps" style={{ paddingInlineStart: 24, marginBlock: 0 }}>
          {steps.map((s) => (
            <li key={s.slice(0, 40)}>{s}</li>
          ))}
        </ol>
      </Card>
    </article>
  );
}
