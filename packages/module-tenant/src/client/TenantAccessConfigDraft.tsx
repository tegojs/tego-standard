import React, { useEffect, useRef, useState } from 'react';
import { useAPIClient } from '@tachybase/client';

import { Alert, Button, Card, Col, Form, Input, Row, Select, Space, Switch, Tag, Typography } from 'antd';

import type { AccessConfig, AccessRule } from '../server/access-control/types';
import { useTenantTranslation } from './locale';
import { TenantAccessConditionEditor } from './TenantAccessConditionEditor';

interface DraftProps {
  identity: { dataSourceKey: string; collectionName: string; collectionKey: string };
  config: AccessConfig;
  onClose: () => void;
  onSaved: (config: AccessConfig) => void;
  onSavingChange?: (saving: boolean) => void;
}

/** Compare JSON response contents independently of object key order. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || typeof left !== 'object' || !right || typeof right !== 'object') return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) => Object.hasOwn(right, key) && sameJson(value, (right as Record<string, unknown>)[key]),
    )
  );
}

/** A disposable, audited editor. Persisting a revision does not activate business enforcement. */
export function TenantAccessConfigDraft({ identity, config, onClose, onSaved, onSavingChange }: DraftProps) {
  const api = useAPIClient();
  const { t } = useTenantTranslation();
  const [draft, setDraft] = useState<AccessConfig>(() => JSON.parse(JSON.stringify(config)));
  const [selectedRuleId, setSelectedRuleId] = useState<string | undefined>(config.rules[0]?.id);
  const [pending, setPending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<{ success?: boolean; saved?: boolean; error?: string }>();
  const request = useRef<AbortController>();
  const ruleIds = useRef(new Set(config.rules.map((rule) => rule.id)));
  const ruleSequence = useRef(0);
  const selectedIndex = draft.rules.findIndex((rule) => rule.id === selectedRuleId);
  const selectedRule = draft.rules[selectedIndex];
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
  const addRule = () => {
    if (pending || draft.rules.length >= 100) return;
    let id: string;
    do {
      id = `rule-${++ruleSequence.current}`;
    } while (ruleIds.current.has(id));
    ruleIds.current.add(id);
    change({
      ...draft,
      rules: [
        ...draft.rules,
        {
          id,
          name: t('New rule'),
          enabled: false,
          category: 'visibility',
          subject: { type: 'constant', value: false },
          condition: { type: 'constant', value: false },
        },
      ],
    });
    setSelectedRuleId(id);
  };
  const removeRule = (index: number) => {
    const next = draft.rules.filter((_, position) => position !== index);
    change({ ...draft, rules: next });
    if (selectedRuleId === draft.rules[index]?.id) setSelectedRuleId(next[Math.min(index, next.length - 1)]?.id);
  };
  const discard = () => {
    request.current?.abort();
    onClose();
  };
  const submit = async (kind: 'validate' | 'save') => {
    if (request.current && !request.current.signal.aborted) return;
    const controller = new AbortController();
    request.current = controller;
    const role = api.auth?.role;
    setPending(true);
    setSaving(kind === 'save');
    if (kind === 'save') onSavingChange?.(true);
    setResult(undefined);
    try {
      const response = await api.request<{ data: { identity: DraftProps['identity']; config: AccessConfig } }>({
        url: kind === 'save' ? 'tenants:saveAccessConfig' : 'tenants:validateAccessConfig',
        method: 'post',
        headers: { 'X-Data-Source': 'main' },
        skipNotify: true,
        signal: controller.signal,
        data: {
          dataSourceKey: identity.dataSourceKey,
          collectionName: identity.collectionName,
          collectionKey: identity.collectionKey,
          config: draft,
        },
      });
      const expectedConfig = kind === 'save' ? { ...draft, revision: draft.revision + 1 } : draft;
      if (!sameJson(response.data.data.identity, identity) || !sameJson(response.data.data.config, expectedConfig))
        throw new Error(`${kind} response does not match the submitted configuration`);
      if (!controller.signal.aborted && api.auth?.role === role) {
        if (kind === 'save') onSaved(response.data.data.config);
        setResult(kind === 'save' ? { saved: true } : { success: true });
      }
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
              : t(
                  kind === 'save'
                    ? 'Unable to save the rules. Please refresh and try again.'
                    : 'Unable to validate the draft. Please try again.',
                ),
        });
    } finally {
      if (!controller.signal.aborted) setPending(false);
      if (!controller.signal.aborted) setSaving(false);
      if (kind === 'save') onSavingChange?.(false);
      if (request.current === controller) request.current = undefined;
    }
  };

  return (
    <Card size="small" title={t('Rule draft')}>
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Alert
          type="info"
          showIcon
          message={t(
            'Changes stay in this window until saved. Validation checks the draft without saving or enabling it.',
          )}
          description={t(
            'Saving creates an audited revision. Business requests continue using the active tenant access model until runtime enforcement is connected.',
          )}
        />
        <Typography.Text type="secondary">
          {t('Editing from revision {{revision}}', { revision: config.revision })}
        </Typography.Text>
        <Card size="small" title={t('Ownership setting')}>
          <Space align="center">
            <Switch
              aria-label={t('Manage actual tenant ownership')}
              checked={draft.ownership.enabled}
              disabled={pending}
              onChange={(enabled) => change({ ...draft, ownership: { enabled } })}
            />
            <Space direction="vertical" size={0}>
              <Typography.Text>{t('Manage actual tenant ownership')}</Typography.Text>
              <Typography.Text type="secondary">
                {t('Controls whether this model manages the actual tenantId ownership field.')}
              </Typography.Text>
            </Space>
          </Space>
        </Card>
        <Row gutter={[16, 16]}>
          <Col xs={24} md={8}>
            <Card size="small" title={t('Rules')} extra={<Tag>{draft.rules.length}/100</Tag>}>
              <Space direction="vertical" style={{ display: 'flex' }}>
                {draft.rules.map((rule) => (
                  <Button
                    key={rule.id}
                    block
                    aria-label={`${rule.name || rule.id} ${t(rule.enabled ? 'Enabled' : 'Disabled')}`}
                    aria-pressed={rule.id === selectedRuleId}
                    type={rule.id === selectedRuleId ? 'primary' : 'default'}
                    disabled={pending}
                    onClick={() => setSelectedRuleId(rule.id)}
                    style={{ height: 'auto', minHeight: 40, whiteSpace: 'normal', textAlign: 'left' }}
                  >
                    <Space>
                      <span>{rule.name || rule.id}</span>
                      <Tag color={rule.enabled ? 'green' : 'default'}>{t(rule.enabled ? 'Enabled' : 'Disabled')}</Tag>
                    </Space>
                  </Button>
                ))}
                {!draft.rules.length ? (
                  <Typography.Text type="secondary">
                    {t('No rules yet. Add one to define a condition.')}
                  </Typography.Text>
                ) : null}
                <Button disabled={pending || draft.rules.length >= 100} onClick={addRule}>
                  {t('Add rule')}
                </Button>
              </Space>
            </Card>
          </Col>
          <Col xs={24} md={16}>
            <Card
              size="small"
              title={t('Selected rule')}
              extra={
                selectedRule ? (
                  <Button danger disabled={pending} onClick={() => removeRule(selectedIndex)}>
                    {t('Remove rule')} {selectedRule.id}
                  </Button>
                ) : null
              }
            >
              {selectedRule ? (
                <Form layout="vertical" disabled={pending}>
                  <Form.Item label={t('Rule name')}>
                    <Input
                      aria-label={t('Rule name')}
                      value={selectedRule.name}
                      onChange={(event) => changeRule(selectedIndex, { name: event.target.value })}
                    />
                  </Form.Item>
                  <Row gutter={16}>
                    <Col xs={24} sm={16}>
                      <Form.Item label={t('Rule category')}>
                        <Select
                          aria-label={t('Rule category')}
                          value={selectedRule.category}
                          options={[
                            { value: 'ownership', label: t('Ownership rules') },
                            { value: 'visibility', label: t('Visibility rules') },
                          ]}
                          onChange={(category: AccessRule['category']) => changeRule(selectedIndex, { category })}
                        />
                      </Form.Item>
                    </Col>
                    <Col xs={24} sm={8}>
                      <Form.Item label={t('Rule enabled')}>
                        <Switch
                          aria-label={t('Rule enabled')}
                          checked={selectedRule.enabled}
                          onChange={(enabled) => changeRule(selectedIndex, { enabled })}
                        />
                      </Form.Item>
                    </Col>
                  </Row>
                  <Form.Item label={t('Visitor conditions')}>
                    <TenantAccessConditionEditor
                      value={selectedRule.subject}
                      label={t('Visitor conditions')}
                      subject
                      disabled={pending}
                      onChange={(subject) => changeRule(selectedIndex, { subject })}
                    />
                  </Form.Item>
                  <Form.Item label={t('Record conditions')}>
                    <TenantAccessConditionEditor
                      value={selectedRule.condition}
                      label={t('Record conditions')}
                      disabled={pending}
                      onChange={(condition) => changeRule(selectedIndex, { condition })}
                    />
                  </Form.Item>
                </Form>
              ) : (
                <Typography.Text type="secondary">{t('Select a rule from the list or add a new one.')}</Typography.Text>
              )}
            </Card>
          </Col>
        </Row>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {t('Visibility rules never grant editing or deletion.')}
        </Typography.Paragraph>
        <Space wrap>
          <Button type="primary" disabled={pending} loading={saving} onClick={() => void submit('save')}>
            {t('Save rules')}
          </Button>
          <Button disabled={pending} loading={pending && !saving} onClick={() => void submit('validate')}>
            {t('Validate draft')}
          </Button>
          <Button disabled={saving} onClick={discard}>
            {t('Discard draft')}
          </Button>
        </Space>
        {result?.success ? (
          <Alert
            type="success"
            showIcon
            message={t('Draft validation passed. Changes have not been saved or enabled.')}
          />
        ) : null}
        {result?.saved ? (
          <Alert
            type="success"
            showIcon
            message={t('Rules saved as revision {{revision}}.', { revision: draft.revision + 1 })}
          />
        ) : null}
        {result?.error ? <Alert type="error" showIcon message={result.error} /> : null}
      </Space>
    </Card>
  );
}
