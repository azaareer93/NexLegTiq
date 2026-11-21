import { Button } from 'antd';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';

import type { HelpSlug } from '../articles';

/** "How it works" under an empty state's main action: the Help Center article about that page (MVP-109). */
export function HowItWorksLink({ slug }: { readonly slug: HelpSlug }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Button
      type="link"
      onClick={() => void navigate(`/help/${slug}`)}
      data-testid={`how-it-works-${slug}`}
    >
      {t('help.howItWorks')}
    </Button>
  );
}
