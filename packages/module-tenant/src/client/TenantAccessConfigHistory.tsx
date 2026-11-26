import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@tachybase/client';

import { Alert, Button, Card, List, Space, Spin, Typography } from 'antd';

import type { AccessConfigRevisionPage } from '../server/access-control/config-store';
import type { AccessConfig } from '../server/access-control/types';
import { useTenantTranslation } from './locale';
import { TenantAccessConfigDraft } from './TenantAccessConfigDraft';

interface HistoryProps {
  identity: { dataSourceKey: string; collectionName: string; collectionKey: string };
  baseRevision: number;
  onClose: () => void;
  onSaved: (config: AccessConfig) => void;
  onSavingChange?: (saving: boolean) => void;
}

function sameIdentity(value: HistoryProps['identity'], expected: HistoryProps['identity']) {
  return (
    value?.dataSourceKey === expected.dataSourceKey &&
    value?.collectionName === expected.collectionName &&
    value?.collectionKey === expected.collectionKey
  );
}

function errorMessage(error: unknown, fallback: string) {
  const response = (error as { response?: { status?: number; data?: { errors?: Array<{ message?: unknown }> } } })
    ?.response;
  const message = response?.data?.errors?.[0]?.message;
  return response?.status >= 400 && response?.status < 500 && typeof message === 'string' && message
    ? message
    : fallback;
}

/** Mount a fresh history when the saved selection, role or refresh changes; writes only through an explicit restored draft save. */
export function TenantAccessConfigHistory({ identity, baseRevision, onClose, onSaved, onSavingChange }: HistoryProps) {
  const api = useAPIClient();
  const { t, language } = useTenantTranslation();
  const role = api.auth?.role;
  const [page, setPage] = useState<AccessConfigRevisionPage>();
  const [currentRevision, setCurrentRevision] = useState(baseRevision);
  const [draft, setDraft] = useState<{ sourceRevision: number; config: AccessConfig }>();
  const [pending, setPending] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const request = useRef<AbortController>();
  const loadFailure = t('Unable to load rule history. Try again.');
  const draftFailure = t('Unable to prepare this revision. Refresh saved rules and try again.');

  const load = useCallback(
    async (beforeRevision?: number, preserveDraft = false) => {
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setPage(undefined);
      if (!preserveDraft) setDraft(undefined);
      setError(undefined);
      setPending(true);
      try {
        const response = await api.request<{ data: AccessConfigRevisionPage & { identity: HistoryProps['identity'] } }>(
          {
            url: 'tenants:listAccessConfigRevisions',
            method: 'post',
            headers: { 'X-Data-Source': 'main' },
            skipNotify: true,
            signal: controller.signal,
            data: {
              dataSourceKey: identity.dataSourceKey,
              collectionName: identity.collectionName,
              limit: 20,
              ...(beforeRevision === undefined ? {} : { beforeRevision }),
            },
          },
        );
        const next = response.data.data;
        let previous = beforeRevision;
        if (
          !sameIdentity(next?.identity, identity) ||
          !Number.isSafeInteger(next.currentRevision) ||
          next.currentRevision < baseRevision ||
          !Array.isArray(next.revisions) ||
          next.revisions.length > 20
        )
          throw new Error('History response does not match selection');
        for (const item of next.revisions) {
          if (
            !Number.isSafeInteger(item.revision) ||
            item.revision < 1 ||
            item.revision > next.currentRevision ||
            (previous !== undefined && item.revision >= previous) ||
            typeof item.actorUserId !== 'string' ||
            !item.actorUserId ||
            typeof item.savedAt !== 'string' ||
            !Number.isFinite(Date.parse(item.savedAt))
          )
            throw new Error('Invalid history summary');
          previous = item.revision;
        }
        if (next.nextBefore !== null && (!next.revisions.length || next.nextBefore !== previous))
          throw new Error('Invalid history cursor');
        if (!controller.signal.aborted && api.auth?.role === role) {
          setCurrentRevision(next.currentRevision);
          setPage(next);
        }
      } catch (failure) {
        if (!controller.signal.aborted && api.auth?.role === role) setError(errorMessage(failure, loadFailure));
      } finally {
        if (!controller.signal.aborted && api.auth?.role === role) setPending(false);
        if (request.current === controller) request.current = undefined;
      }
    },
    [api, identity, baseRevision, role, loadFailure],
  );

  useEffect(() => {
    void load();
    return () => request.current?.abort();
  }, [load]);

  const prepare = async (revision: number) => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setDraft(undefined);
    setError(undefined);
    setPending(true);
    try {
      const response = await api.request<{
        data: { identity: HistoryProps['identity']; sourceRevision: number; config: AccessConfig };
      }>({
        url: 'tenants:previewAccessConfigRevision',
        method: 'post',
        headers: { 'X-Data-Source': 'main' },
        skipNotify: true,
        signal: controller.signal,
        data: { dataSourceKey: identity.dataSourceKey, collectionName: identity.collectionName, revision },
      });
      const next = response.data.data;
      if (
        !sameIdentity(next?.identity, identity) ||
        next.sourceRevision !== revision ||
        !Number.isSafeInteger(next.config?.revision) ||
        next.config.revision < Math.max(currentRevision, revision) ||
        next.config.schemaVersion !== 1 ||
        !Array.isArray(next.config.rules)
      )
        throw new Error('Historical draft does not match selection and current editing base');
      if (!controller.signal.aborted && api.auth?.role === role) {
        const revisionAdvanced = next.config.revision > currentRevision;
        setCurrentRevision(next.config.revision);
        setDraft(next);
        if (revisionAdvanced) void load(undefined, true);
      }
    } catch (failure) {
      if (!controller.signal.aborted && api.auth?.role === role) setError(errorMessage(failure, draftFailure));
    } finally {
      if (!controller.signal.aborted && api.auth?.role === role) setPending(false);
      if (request.current === controller) request.current = undefined;
    }
  };

  return (
    <Card
      size="small"
      title={t('Rule history')}
      extra={
        <Button disabled={saving} onClick={onClose}>
          {t('Close rule history')}
        </Button>
      }
    >
      <Space direction="vertical" style={{ display: 'flex' }}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        {pending ? <Spin aria-label={t('Loading rule history')} /> : null}
        {draft ? (
          <>
            <Alert
              type="info"
              showIcon
              message={t(
                'Draft from revision {{source}}, based on current revision {{base}}. Changes have not been saved or enabled.',
                { source: draft.sourceRevision, base: draft.config.revision },
              )}
            />
            <TenantAccessConfigDraft
              key={draft.sourceRevision}
              identity={identity}
              config={draft.config}
              onSavingChange={(value) => {
                setSaving(value);
                onSavingChange?.(value);
              }}
              onClose={() => setDraft(undefined)}
              onSaved={(savedConfig) => {
                setDraft(undefined);
                onSaved(savedConfig);
              }}
            />
          </>
        ) : (
          <>
            <Space>
              <Button disabled={pending} onClick={() => void load()}>
                {t('Newest revisions')}
              </Button>
              <Button disabled={pending || page?.nextBefore == null} onClick={() => void load(page!.nextBefore!)}>
                {t('Older revisions')}
              </Button>
            </Space>
            {page ? (
              <List
                size="small"
                dataSource={[...page.revisions]}
                locale={{ emptyText: t('No rule history is available.') }}
                renderItem={(item) => (
                  <List.Item>
                    <Space direction="vertical">
                      <Typography.Text>{t('Revision {{revision}}', { revision: item.revision })}</Typography.Text>
                      <Typography.Text type="secondary">
                        {t('Saved by {{user}} at {{time}}', {
                          user: item.actorUserId,
                          time: new Date(item.savedAt).toLocaleString(language),
                        })}
                      </Typography.Text>
                      <Button disabled={pending} onClick={() => void prepare(item.revision)}>
                        {t('Create draft from revision {{revision}}', { revision: item.revision })}
                      </Button>
                    </Space>
                  </List.Item>
                )}
              />
            ) : null}
          </>
        )}
      </Space>
    </Card>
  );
}
