import { PageHeader } from '@nexlegtiq/shared-ui';
import { Tabs } from 'antd';
import { useTranslation } from 'react-i18next';

import { CourtReportsTab } from '../components/CourtReportsTab';
import { OfficeCourtsTab } from '../components/OfficeCourtsTab';
import { PlatformCourtsTab } from '../components/PlatformCourtsTab';

/** `/courts`: platform courts per country, missing-court reports and offices' legacy courts (MVP-167, D-266). */
export function CourtsPage(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section data-testid="page-courts">
      <PageHeader title={t('admin.courts.title')} />
      <Tabs
        destroyOnHidden
        items={[
          { key: 'courts', label: t('admin.courts.tabs.courts'), children: <PlatformCourtsTab /> },
          {
            key: 'reports',
            label: <span data-testid="tab-reports">{t('admin.courts.tabs.reports')}</span>,
            children: <CourtReportsTab />,
          },
          {
            key: 'office',
            label: (
              <span data-testid="tab-office-courts">{t('admin.courts.tabs.officeCourts')}</span>
            ),
            children: <OfficeCourtsTab />,
          },
        ]}
      />
    </section>
  );
}
