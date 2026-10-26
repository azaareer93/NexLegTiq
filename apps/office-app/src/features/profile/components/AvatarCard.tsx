import { UploadOutlined } from '@ant-design/icons';
import type { Profile } from '@nexlegtiq/shared-contracts';
import { useApiErrorHandler } from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { App, Avatar, Button, Card, Flex, Typography, Upload } from 'antd';
import { useTranslation } from 'react-i18next';

import { initialsOf } from '../../shell/components/ProfileMenu';
import { useRemoveAvatar, useUploadAvatar } from '../api/use-profile';
import { squareAvatar } from '../avatar-image';

/** The picture (D-146): cropped and resized in the browser, then uploaded; the API checks type and size again. */
export function AvatarCard({ profile }: { readonly profile: Profile }): React.JSX.Element {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { notify } = useApiErrorHandler();
  const upload = useUploadAvatar();
  const remove = useRemoveAvatar();
  const pick = async (file: File) => {
    const image = await squareAvatar(file);
    if (!image) {
      void message.error(t('profile.avatar.unreadable'));
      return;
    }
    upload.mutate(
      { image, filename: 'avatar.jpg' },
      { onSuccess: () => void message.success(t('profile.avatar.uploaded')), onError: notify },
    );
  };
  return (
    <Card title={t('profile.avatar.title')} data-testid="profile-avatar">
      <Flex gap={16} align="center" wrap>
        <Avatar
          size={72}
          src={profile.avatar?.url}
          alt={t('profile.avatar.alt', { name: isolate(profile.fullName) })}
          data-testid="profile-avatar-image"
        >
          <bdi>{initialsOf(profile.fullName)}</bdi>
        </Avatar>
        <Flex vertical gap={8}>
          <Flex gap={8} wrap>
            <Upload
              accept="image/png,image/jpeg"
              showUploadList={false}
              beforeUpload={(file) => {
                void pick(file);
                return false;
              }}
            >
              <Button
                icon={<UploadOutlined />}
                loading={upload.isPending}
                data-testid="profile-avatar-upload"
              >
                {t('profile.avatar.upload')}
              </Button>
            </Upload>
            {profile.avatar ? (
              <Button
                danger
                loading={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => void message.success(t('profile.avatar.removed')),
                    onError: notify,
                  })
                }
                data-testid="profile-avatar-remove"
              >
                {t('profile.avatar.remove')}
              </Button>
            ) : null}
          </Flex>
          <Typography.Text type="secondary">{t('profile.avatar.hint')}</Typography.Text>
        </Flex>
      </Flex>
    </Card>
  );
}
