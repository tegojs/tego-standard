import React, { useEffect, useState } from 'react';
import { useAPIClient } from '@tachybase/client';

import { Alert, Button, Card, Descriptions, Drawer, Space, Spin, Tag, Typography } from 'antd';

import type { AccessCondition, AccessConfig, AccessOperand, ContextPath } from '../server/access-control/types';
import { useTenantTranslation } from './locale';
import { TenantAccessConfigDraft } from './TenantAccessConfigDraft';
import { TenantAccessConfigHistory } from './TenantAccessConfigHistory';
import { TenantFileAccessNotice } from './TenantFileAccessNotice';

interface SavedConfig {
  identity: { dataSourceKey: string; collectionName: string; collectionKey: string };
  config: AccessConfig | null;
}

const contextLabels: Record<ContextPath, string> = {
  'tenant.id': 'Current tenant',
  'user.id': 'Current user',
  'role.name': 'Current role',
  'tenant.ancestorIds': 'Current tenant ancestors',
  'tenant.descendantIds': 'Current tenant descendants',
};
const operatorLabels = {
  eq: 'equals',
  ne: 'does not equal',
  gt: 'is greater than',
  gte: 'is greater than or equal to',
  lt: 'is less than',
  lte: 'is less than or equal to',
  in: 'is one of',
  notIn: 'is not one of',
  includes: 'contains',
};

/** Render the validated condition tree without executing expressions or translating stored names. */
function ConditionView({ condition }: { condition: AccessCondition }) {
  const { t } = useTenantTranslation();
  const operand = (value: AccessOperand): string => {
    switch (value.type) {
      case 'field':
        return t('Field: {{path}}', { path: value.path });
      case 'context':
        return t(contextLabels[value.path]);
      case 'literal':
        return JSON.stringify(value.value);
    }
  };
  const group = (label: string, children: AccessCondition[]) => (
    <div>
      <span>{label}</span>
      <ul style={{ marginBottom: 0 }}>
        {children.map((child, index) => (
          <li key={index}>
            <ConditionView condition={child} />
          </li>
        ))}
      </ul>
    </div>
  );
  switch (condition.type) {
    case 'constant':
      return <span>{t(condition.value ? 'Always matches' : 'Never matches')}</span>;
    case 'all':
    case 'any':
      if (!condition.children.length)
        return <span>{t(condition.type === 'all' ? 'Always matches' : 'Never matches')}</span>;
      return group(
        t(condition.type === 'all' ? 'All conditions must match' : 'Any condition may match'),
        condition.children,
      );
    case 'not':
      return group(t('Must not match'), [condition.child]);
    case 'compare':
      return (
        <span>{`${operand(condition.left)} ${t(operatorLabels[condition.operator])} ${operand(condition.right)}`}</span>
      );
    case 'isNull':
      return <span>{`${operand(condition.operand)} ${t('is empty (null)')}`}</span>;
    case 'exists':
      return group(t('At least one related record matches: {{path}}', { path: condition.path }), [condition.condition]);
    case 'tenantRelation': {
      // Relations describe the visitor relative to the operand, as in the SQL compiler.
      if (condition.relation === 'same' && !condition.includeSelf)
        return (
          <span>
            {t(
              'No tenant relationship matches: {{tenant}}. If the tenant is empty, neither this condition nor its negation matches.',
              { tenant: operand(condition.tenant) },
            )}
          </span>
        );
      const label =
        condition.relation === 'same'
          ? 'Current tenant is the specified tenant'
          : condition.relation === 'ancestor'
            ? condition.includeSelf
              ? 'Current tenant is an ancestor of the specified tenant, or is that tenant'
              : 'Current tenant is an ancestor of the specified tenant'
            : condition.includeSelf
              ? 'Current tenant is a descendant of the specified tenant, or is that tenant'
              : 'Current tenant is a descendant of the specified tenant';
      return <span>{`${t(label)}: ${operand(condition.tenant)}`}</span>;
    }
  }
}

/** Read-only management view; persisted configuration is not evidence of runtime activation. */
export function TenantAccessConfigView({
  collection,
  onClose,
}: {
  collection: { name: string; title?: string; template?: string };
  onClose: () => void;
}) {
  const api = useAPIClient();
  const { t } = useTenantTranslation();
  const role = api.auth?.role || undefined;
  const [refresh, setRefresh] = useState(0);
  const [editingKey, setEditingKey] = useState<string>();
  const [historyKey, setHistoryKey] = useState<string>();
  const key = JSON.stringify([collection.name, role, refresh]);
  useEffect(() => setEditingKey(undefined), [key]);
  useEffect(() => setHistoryKey(undefined), [key]);
  const [result, setResult] = useState<{ key: string; report?: SavedConfig; error?: string }>();
  const current = result?.key === key ? result : undefined;
  const loading = !current;
  const config = current?.report?.config;
  const failureMessage = t('Unable to load saved rules. Refresh to try again.');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await api.request<{ data: SavedConfig }>({
          url: 'tenants:readAccessConfig',
          method: 'post',
          headers: { 'X-Data-Source': 'main' },
          skipNotify: true,
          signal: controller.signal,
          data: { dataSourceKey: 'main', collectionName: collection.name },
        });
        const next = response.data.data;
        if (
          next.identity.dataSourceKey !== 'main' ||
          next.identity.collectionName !== collection.name ||
          next.config === undefined
        )
          throw new Error('Saved rule response does not match selection');
        if (active) setResult({ key, report: next });
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: { errors?: Array<{ message?: unknown }> } } })
          ?.response;
        const message = response?.data?.errors?.[0]?.message;
        const status = response?.status;
        const expected = typeof status === 'number' && status >= 400 && status < 500;
        if (active)
          setResult({ key, error: expected && typeof message === 'string' && message ? message : failureMessage });
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, collection.name, role, key, failureMessage]);

  return (
    <Drawer open width={720} title={t('View saved rules')} onClose={onClose}>
      <Space direction="vertical" size={16} style={{ display: 'flex', overflowWrap: 'anywhere' }}>
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{collection.title || collection.name}</Typography.Text>
          <Typography.Text type="secondary">{collection.name}</Typography.Text>
        </Space>
        <Alert
          type="info"
          showIcon
          message={t(
            'Saved rules are shown for inspection only. This view does not enable them or verify their use in business requests.',
          )}
        />
        <TenantFileAccessNotice template={collection.template} />
        <Button disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {t('Refresh saved rules')}
        </Button>
        {loading ? <Spin aria-label={t('Loading saved rules')} /> : null}
        {current?.error ? <Alert type="error" showIcon message={current.error} /> : null}
        {config === null ? (
          <>
            <Typography.Text>{t('No access rules have been saved for this collection.')}</Typography.Text>
            {editingKey === key ? (
              <TenantAccessConfigDraft
                key={key}
                identity={current!.report!.identity}
                config={{ schemaVersion: 1, revision: 0, ownership: { enabled: true }, rules: [] }}
                onClose={() => setEditingKey(undefined)}
              />
            ) : (
              <Button onClick={() => setEditingKey(key)}>{t('Create rule draft')}</Button>
            )}
          </>
        ) : null}
        {config ? (
          <>
            {historyKey === key ? (
              <TenantAccessConfigHistory
                key={key}
                identity={current!.report!.identity}
                baseRevision={config.revision}
                onClose={() => setHistoryKey(undefined)}
              />
            ) : editingKey === key ? (
              <TenantAccessConfigDraft
                key={key}
                identity={current!.report!.identity}
                config={config}
                onClose={() => setEditingKey(undefined)}
              />
            ) : (
              <Space>
                <Button onClick={() => setEditingKey(key)}>{t('Edit rule draft')}</Button>
                <Button onClick={() => setHistoryKey(key)}>{t('View rule history')}</Button>
              </Space>
            )}
            <Descriptions bordered size="small" column={1}>
              <Descriptions.Item label={t('Configuration revision')}>{config.revision}</Descriptions.Item>
              <Descriptions.Item label={t('Structure version')}>{config.schemaVersion}</Descriptions.Item>
              <Descriptions.Item label={t('Manage actual tenant ownership')}>
                {t(config.ownership.enabled ? 'Enabled' : 'Disabled')}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph>{t('Visibility rules never grant editing or deletion.')}</Typography.Paragraph>
            {!config.rules.length ? (
              <Typography.Text>{t('No rules in this saved configuration.')}</Typography.Text>
            ) : null}
            {config.rules.map((rule) => (
              <Card
                key={rule.id}
                size="small"
                title={rule.name}
                extra={<Tag>{t(rule.enabled ? 'Enabled' : 'Disabled')}</Tag>}
              >
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label={t('Rule ID')}>{rule.id}</Descriptions.Item>
                  <Descriptions.Item label={t('Rule category')}>
                    {t(rule.category === 'ownership' ? 'Ownership rules' : 'Visibility rules')}
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Visitor conditions')}>
                    <ConditionView condition={rule.subject} />
                  </Descriptions.Item>
                  <Descriptions.Item label={t('Record conditions')}>
                    <ConditionView condition={rule.condition} />
                  </Descriptions.Item>
                </Descriptions>
              </Card>
            ))}
          </>
        ) : null}
      </Space>
    </Drawer>
  );
}
