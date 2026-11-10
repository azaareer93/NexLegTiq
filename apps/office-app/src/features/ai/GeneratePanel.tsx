import type { AiSummaryListItem, Document } from '@nexlegtiq/shared-contracts';
import { Bdi } from '@nexlegtiq/shared-ui';
import { Button, Card, Form, Select } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

type Language = AiSummaryListItem['language'];

/** Picks a ready document and a language, then asks for the summary. */
export function GeneratePanel({
  documents,
  loading,
  onAsk,
}: {
  readonly documents: readonly Document[];
  readonly loading: boolean;
  readonly onAsk: (documentId: string, language: Language) => void;
}) {
  const { t } = useTranslation();
  const [documentId, setDocumentId] = useState<string>();
  const [language, setLanguage] = useState<Language>('AR');
  return (
    <Card size="small" title={t('aiSummary.generate.title')} style={{ flex: 1 }}>
      <Form layout="inline" onFinish={() => documentId && onAsk(documentId, language)}>
        <Form.Item label={t('aiSummary.generate.document')} htmlFor="ai-document-input">
          <Select
            style={{ minInlineSize: 240 }}
            value={documentId}
            onChange={setDocumentId}
            notFoundContent={t('aiSummary.generate.noDocuments')}
            options={documents.map((d) => ({ value: d.id, label: <Bdi>{d.name}</Bdi> }))}
            id="ai-document-input"
            data-testid="ai-document"
          />
        </Form.Item>
        <Form.Item label={t('aiSummary.generate.language')} htmlFor="ai-language-input">
          <Select
            style={{ minInlineSize: 120 }}
            value={language}
            onChange={setLanguage}
            options={(['AR', 'EN'] as const).map((value) => ({
              value,
              label: t(`aiSummary.language.${value}`),
            }))}
            id="ai-language-input"
            data-testid="ai-language"
          />
        </Form.Item>
        <Button
          type="primary"
          htmlType="submit"
          disabled={!documentId}
          loading={loading}
          data-testid="ai-generate"
        >
          {t('aiSummary.generate.submit')}
        </Button>
      </Form>
    </Card>
  );
}
