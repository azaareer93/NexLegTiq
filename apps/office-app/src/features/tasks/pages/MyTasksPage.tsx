import { PageHeader } from '@nexlegtiq/shared-ui';
import { useTranslation } from 'react-i18next';

import { HelpLink } from '../../help';
import { TasksView } from '../components/TasksView';

/** `/tasks`: the caller's tasks across files and personal ones (D-098 `assignee=me`). */
export function MyTasksPage(): React.JSX.Element {
  const { t } = useTranslation();
  return (
    <section data-testid="page-tasks">
      <PageHeader title={t('tasks.page.title')} extra={<HelpLink slug="tasks" />} />
      <TasksView scope={{ assignee: 'me' }} />
    </section>
  );
}
