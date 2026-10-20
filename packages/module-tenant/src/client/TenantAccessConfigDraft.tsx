import React, { useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@tachybase/client';

import { Alert, Button, Card, Form, Input, Select, Space, Switch, Typography } from 'antd';

import type { AccessConfig, AccessRule } from '../server/access-control/types';
import { useTenantTranslation } from './locale';
import { TenantAccessConditionEditor } from './TenantAccessConditionEditor';

interface DraftProps {
  identity: { dataSourceKey: string; collectionName: string; collectionKey: string };
  config: AccessConfig;
  onClose: () => void;
}

/** Compare JSON response contents independently of object key order. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) => Object.hasOwn(right, key) && sameJson(value, (right as Record<string, unknown>)[key]),
    )
  );
}

/** A disposable draft. Mount a new instance when the saved identity, role or revision changes. */
export function TenantAccessConfigDraft({ identity, config, onClose }: DraftProps) {
  const api = useAPIClient();
  const { t } = useTenantTranslation();
  const [draft, setDraft] = useState<AccessConfig>(() => JSON.parse(JSON.stringify(config)));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ success?: boolean; error?: string }>();
  const request = useRef<AbortController>();
  useEffect(() => () => request.current?.abort(), []);

  const change = (value: AccessConfig) => {
    setDraft(value);
    setResult(undefined);
  };
  const changeRule = (index: number, values: Partial<AccessRule>) =>
    change({
      ...draft,
      rules: draft.rules.map((rule, position) => (index === position ? { ...rule, ...values } : rule)),
    });
  const discard = () => {
    request.current?.abort();
    onClose();
  };
  const validate = async () => {
    if (request.current && !request.current.signal.aborted) return;
    const controller = new AbortController();
    request.current = controller;
    const role = api.auth?.role;
    setPending(true);
    setResult(undefined);
    try {
      const response = await api.request<{ data: { identity: DraftProps['identity']; config: AccessConfig } }>({
        url: 'tenants:validateAccessConfig',
        method: 'post',
        headers: { 'X-Data-Source': 'main' },
        skipNotify: true,
        signal: controller.signal,
        data: { dataSourceKey: identity.dataSourceKey, collectionName: identity.collectionName, config: draft },
      });
      if (!sameJson(response.data.data.identity, identity) || !sameJson(response.data.data.config, draft))
        throw new Error('Validation response does not match draft');
      if (!controller.signal.aborted && api.auth?.role === role) setResult({ success: true });
    } catch (error) {
      const response = (error as { response?: { status?: number; data?: { errors?: Array<{ message?: unknown }> } } })
        ?.response;
      const status = response?.status;
      const message = response?.data?.errors?.[0]?.message;
      if (!controller.signal.aborted && api.auth?.role === role)
        setResult({
          error:
            typeof status === 'number' && status >= 400 && status < 500 && typeof message === 'string' && message
              ? message
              : t('Unable to validate the draft. Please try again.'),
        });
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (request.current === controller) request.current = undefined;
    }
  };

  return (
    <Card size="small" title={t('Rule draft')}>
      <Space direction="vertical" style={{ display: 'flex' }}>
        <Alert
          type="info"
          showIcon
          message={t('Draft changes stay in this window. Validation does not save or enable them.')}
        />
        <Typography.Paragraph>
          {t(
            'Edit rule settings and conditions here. Field and association paths are checked by the server when validating the draft.',
          )}
        </Typography.Paragraph>
        <Form layout="vertical" disabled={pending}>
          <Form.Item label={t('Manage actual tenant ownership')}>
            <Switch
              aria-label={t('Manage actual tenant ownership')}
              checked={draft.ownership.enabled}
              onChange={(enabled) => change({ ...draft, ownership: { enabled } })}
            />
          </Form.Item>
          {draft.rules.map((rule, index) => (
            <Card key={rule.id} size="small" title={rule.id} style={{ marginBottom: 12 }}>
              <Form.Item label={t('Rule name')}>
                <Input
                  aria-label={t('Rule name')}
                  value={rule.name}
                  onChange={(event) => changeRule(index, { name: event.target.value })}
                />
              </Form.Item>
              <Form.Item label={t('Rule category')}>
                <Select
                  aria-label={t('Rule category')}
                  value={rule.category}
                  options={[
                    { value: 'ownership', label: t('Ownership rules') },
                    { value: 'visibility', label: t('Visibility rules') },
                  ]}
                  onChange={(category: AccessRule['category']) => changeRule(index, { category })}
                />
              </Form.Item>
              <Form.Item label={t('Rule enabled')}>
                <Switch
                  aria-label={t('Rule enabled')}
                  checked={rule.enabled}
                  onChange={(enabled) => changeRule(index, { enabled })}
                />
              </Form.Item>
              <Form.Item label={t('Visitor conditions')}>
                <TenantAccessConditionEditor
                  value={rule.subject}
                  label={t('Visitor conditions')}
                  subject
                  disabled={pending}
                  onChange={(subject) => changeRule(index, { subject })}
                />
              </Form.Item>
              <Form.Item label={t('Record conditions')}>
                <TenantAccessConditionEditor
                  value={rule.condition}
                  label={t('Record conditions')}
                  disabled={pending}
                  onChange={(condition) => changeRule(index, { condition })}
                />
              </Form.Item>
            </Card>
          ))}
        </Form>
        <Typography.Paragraph>{t('Visibility rules never grant editing or deletion.')}</Typography.Paragraph>
        <Space>
          <Button aria-label={t('Validate draft')} disabled={pending} loading={pending} onClick={() => void validate()}>
            {t('Validate draft')}
          </Button>
          <Button onClick={discard}>{t('Discard draft')}</Button>
        </Space>
        {result?.success ? (
          <Alert
            type="success"
            showIcon
            message={t('Draft validation passed. Changes have not been saved or enabled.')}
          />
        ) : null}
        {result?.error ? <Alert type="error" showIcon message={result.error} /> : null}
      </Space>
    </Card>
  );
}
