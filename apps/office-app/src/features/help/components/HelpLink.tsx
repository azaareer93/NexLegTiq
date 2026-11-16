import { QuestionCircleOutlined } from '@ant-design/icons';
import { Button, Tooltip } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import { HELP_ARTICLES } from '../articles';
import type { HelpSlug } from '../articles';

/** The "?" next to a page title: opens the article about that page (D-185). */
export function HelpLink({ slug }: { readonly slug: HelpSlug }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const label = t('help.linkLabel', { title: t(`help.articles.${HELP_ARTICLES[slug]}.title`) });
  return (
    <Tooltip title={label}>
      <Button
        type="text"
        icon={<QuestionCircleOutlined />}
        aria-label={label}
        onClick={() => void navigate(`/help/${slug}`)}
        data-testid={`help-link-${slug}`}
      />
    </Tooltip>
  );
}
