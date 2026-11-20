import { Ltr } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Card, Flex, Typography } from 'antd';
import { useTranslation } from 'react-i18next';

import { useOffice } from '../hooks';

/** "Contact your lawyer": the office's phone and email as links a phone can call or mail. */
export function ContactCard({
  officeId,
  lawyerName,
}: {
  readonly officeId: string;
  readonly lawyerName?: string;
}): React.JSX.Element | null {
  const { t } = useTranslation();
  const office = useOffice(officeId);
  if (!office) return null;
  return (
    <Card size="small" title={t('portal.contact.title')} data-testid={`contact-${officeId}`}>
      <Flex vertical gap={8}>
        <Typography.Text>
          {t('portal.contact.body', { office: isolate(office.officeName) })}
        </Typography.Text>
        {lawyerName ? (
          <Typography.Text>
            {t('portal.files.lawyer')}: <bdi>{lawyerName}</bdi>
          </Typography.Text>
        ) : null}
        {office.officePhone ? (
          <Typography.Text>
            {t('portal.contact.phone')}:{' '}
            <a
              href={`tel:${office.officePhone.replace(/[^\d+]/g, '')}`}
              data-testid="contact-phone"
            >
              <Ltr>{office.officePhone}</Ltr>
            </a>
          </Typography.Text>
        ) : null}
        {office.officeEmail ? (
          <Typography.Text>
            {t('portal.contact.email')}:{' '}
            <a href={`mailto:${office.officeEmail}`} data-testid="contact-email">
              <Ltr>{office.officeEmail}</Ltr>
            </a>
          </Typography.Text>
        ) : null}
      </Flex>
    </Card>
  );
}
