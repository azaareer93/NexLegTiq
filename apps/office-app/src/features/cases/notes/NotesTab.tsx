import { LockOutlined, PushpinOutlined } from '@ant-design/icons';
import type { Note } from '@nexlegtiq/shared-contracts';
import { isErrorCode } from '@nexlegtiq/shared-types';
import {
  ApiErrorAlert,
  ConfirmModal,
  EmptyState,
  ErrorState,
  isApiError,
  LoadingSkeleton,
  useApiErrorHandler,
  useFormat,
} from '@nexlegtiq/shared-ui';
import { isolate } from '@nexlegtiq/shared-utils';
import { Button, Card, Checkbox, Flex, Form, Input, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { useNoteMutations, useNotes } from './use-notes';

interface Draft {
  readonly body: string;
  readonly isConfidential: boolean;
  readonly pinned: boolean;
}

/** The new-note form: plain text, optionally confidential (encrypted, D-154) or pinned. */
function NewNote({ fileId }: { readonly fileId: string }) {
  const { t } = useTranslation();
  const { add } = useNoteMutations(fileId);
  const [form] = Form.useForm<Draft>();
  return (
    <Card>
      <Form
        form={form}
        layout="vertical"
        initialValues={{ isConfidential: false, pinned: false }}
        onFinish={(values) => add.mutate(values, { onSuccess: () => form.resetFields() })}
      >
        {add.error ? <ApiErrorAlert error={add.error} /> : null}
        <Form.Item
          name="body"
          label={t('cases.notes.new')}
          rules={[{ required: true, whitespace: true, message: t('validation.required') }]}
        >
          <Input.TextArea rows={3} maxLength={10_000} data-testid="note-body" />
        </Form.Item>
        <Flex gap={16} wrap align="center">
          <Form.Item name="isConfidential" valuePropName="checked" noStyle>
            <Checkbox data-testid="note-confidential">{t('cases.notes.confidential')}</Checkbox>
          </Form.Item>
          <Form.Item name="pinned" valuePropName="checked" noStyle>
            <Checkbox data-testid="note-pinned">{t('cases.notes.pin')}</Checkbox>
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={add.isPending} data-testid="note-add">
            {t('cases.notes.add')}
          </Button>
        </Flex>
      </Form>
    </Card>
  );
}

/** One note: its text as written (never HTML), and the changes its author or OM/SL may make. */
function NoteCard({
  fileId,
  note,
  readOnly,
}: {
  readonly fileId: string;
  readonly note: Note;
  readonly readOnly: boolean;
}) {
  const { t } = useTranslation();
  const format = useFormat();
  const { notify } = useApiErrorHandler();
  const { update, remove } = useNoteMutations(fileId);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [body, setBody] = useState(note.body);
  const may = note.canEdit && !readOnly;
  const save = (change: Partial<Draft>) =>
    update.mutate(
      { id: note.id, body: change },
      { onSuccess: () => setEditing(false), onError: notify },
    );
  return (
    <Card size="small" data-testid={`note-${note.id}`}>
      <Flex vertical gap={8}>
        <Flex gap={8} wrap align="center">
          {note.pinned ? (
            <Tag icon={<PushpinOutlined aria-hidden />}>{t('cases.notes.pinned')}</Tag>
          ) : null}
          {note.isConfidential ? (
            <Tag icon={<LockOutlined aria-hidden />}>{t('cases.notes.confidential')}</Tag>
          ) : null}
          <Typography.Text type="secondary">
            {t('cases.notes.by', { name: isolate(note.author.fullName) })} ·{' '}
            {format.relative(note.createdAt)}
          </Typography.Text>
        </Flex>
        {editing ? (
          <Input.TextArea
            rows={3}
            value={body}
            maxLength={10_000}
            onChange={(event) => setBody(event.target.value)}
            aria-label={t('cases.notes.edit')}
            data-testid={`note-edit-${note.id}`}
          />
        ) : (
          // Plain text: React escapes it, and pre-wrap keeps the writer's line breaks.
          <Typography.Paragraph
            style={{ whiteSpace: 'pre-wrap', marginBlockEnd: 0, unicodeBidi: 'plaintext' }}
          >
            {note.body}
          </Typography.Paragraph>
        )}
        {may ? (
          <Flex gap={8} wrap>
            {editing ? (
              <>
                <Button
                  size="small"
                  type="primary"
                  loading={update.isPending}
                  onClick={() => save({ body })}
                >
                  {t('common.actions.save')}
                </Button>
                <Button size="small" onClick={() => setEditing(false)}>
                  {t('common.actions.cancel')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="small"
                  onClick={() => setEditing(true)}
                  data-testid={`note-edit-button-${note.id}`}
                >
                  {t('common.actions.edit')}
                </Button>
                <Button size="small" onClick={() => save({ pinned: !note.pinned })}>
                  {note.pinned ? t('cases.notes.unpin') : t('cases.notes.pin')}
                </Button>
                <Button
                  size="small"
                  danger
                  onClick={() => setDeleting(true)}
                  data-testid={`note-delete-${note.id}`}
                >
                  {t('common.actions.delete')}
                </Button>
              </>
            )}
          </Flex>
        ) : null}
      </Flex>
      <ConfirmModal
        open={deleting}
        danger
        title={t('cases.notes.deleteTitle')}
        confirmText={t('common.actions.delete')}
        loading={remove.isPending}
        onConfirm={() =>
          remove.mutate(note.id, { onSettled: () => setDeleting(false), onError: notify })
        }
        onCancel={() => setDeleting(false)}
      >
        {t('cases.notes.deleteBody')}
      </ConfirmModal>
    </Card>
  );
}

/** `?tab=notes` (MVP-65, D-154): the file's internal notes, pinned first; never shown on the client portal. */
export function NotesTab({
  fileId,
  canWrite,
  readOnly,
}: {
  readonly fileId: string;
  readonly canWrite: boolean;
  readonly readOnly: boolean;
}) {
  const { t } = useTranslation();
  const { referenceOf } = useApiErrorHandler();
  const notes = useNotes(fileId);
  if (notes.isError) {
    return (
      <ErrorState
        code={
          isApiError(notes.error) && isErrorCode(notes.error.code) ? notes.error.code : undefined
        }
        requestId={referenceOf(notes.error)}
        onRetry={() => void notes.refetch()}
      />
    );
  }
  if (!notes.data) return <LoadingSkeleton rows={4} />;
  return (
    <Flex vertical gap={16} data-testid="notes-tab">
      {canWrite && !readOnly ? <NewNote fileId={fileId} /> : null}
      {notes.data.length === 0 ? (
        <EmptyState title={t('cases.notes.empty')} />
      ) : (
        notes.data.map((note) => (
          <NoteCard key={note.id} fileId={fileId} note={note} readOnly={readOnly} />
        ))
      )}
    </Flex>
  );
}
