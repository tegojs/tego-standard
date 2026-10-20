import React, { useEffect, useMemo, useState } from 'react';
import { useAPIClient } from '@tachybase/client';

import { Alert, Button, Descriptions, Drawer, Space, Spin, Table, Tag, Typography } from 'antd';

import type { AccessMigrationPreview } from '../server/access-control/migration-preview';
import { useTenantTranslation } from './locale';
import type { TenantRecord } from './tenant-tree';

interface TenantMigrationPreviewProps {
  collection: { name: string; title?: string };
  tenants: TenantRecord[];
  onClose: () => void;
}

interface PreviewState {
  key: string;
  report?: AccessMigrationPreview;
  error?: string;
}

const actions = ['list', 'create', 'update', 'destroy'] as const;
const actionLabels: Record<string, string> = {
  list: 'View records',
  create: 'Create records',
  update: 'Edit records',
  destroy: 'Delete records',
};
const treatmentLabels: Record<string, string> = {
  'delegate-builtin-scope': 'The new rules can take over the built-in tenant condition.',
  'retain-role-scope': 'Keep existing role conditions.',
  'no-direct-resource-grant': 'No separate collection grant.',
};
const modeDescriptions = {
  shared: 'All records remain subject to role permissions.',
  tenantScoped: 'Records owned by the current tenant remain subject to role permissions.',
  tenantInherited: 'Records owned by the current tenant or its descendants remain subject to role permissions.',
};

/** A read-only report. There is deliberately no save, activation or business-record operation here. */
export function TenantMigrationPreview({ collection, tenants, onClose }: TenantMigrationPreviewProps) {
  const api = useAPIClient();
  const { t } = useTenantTranslation();
  const role = api.auth?.role || undefined;
  const [refresh, setRefresh] = useState(0);
  const key = JSON.stringify([collection.name, role, refresh]);
  const [result, setResult] = useState<PreviewState>();
  const current = result?.key === key ? result : undefined;
  const loading = !current;
  const report = current?.report;
  const tenantNames = useMemo(() => new Map(tenants.map((tenant) => [String(tenant.id), tenant.name])), [tenants]);
  const failureMessage = t('Migration preview failed. Refresh to try again.');

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const load = async () => {
      try {
        const response = await api.request<{ data: AccessMigrationPreview }>({
          url: 'tenants:previewAccessMigration',
          method: 'post',
          headers: { 'X-Data-Source': 'main' },
          skipNotify: true,
          signal: controller.signal,
          data: {
            dataSourceKey: 'main',
            collectionName: collection.name,
            roleActions: role ? actions.map((action) => ({ role, action })) : [],
          },
        });
        const next = response.data.data;
        if (next.identity.dataSourceKey !== 'main' || next.identity.collectionName !== collection.name)
          throw new Error('Migration preview identity changed');
        if (active) setResult({ key, report: next });
      } catch (error) {
        const response = (error as { response?: { status?: number; data?: { errors?: Array<{ message?: unknown }> } } })
          ?.response;
        const message = response?.data?.errors?.[0]?.message;
        const status = response?.status;
        const expectedError = typeof status === 'number' && status >= 400 && status < 500;
        if (active)
          setResult({ key, error: expectedError && typeof message === 'string' && message ? message : failureMessage });
      }
    };
    void load();
    return () => {
      active = false;
      controller.abort();
    };
  }, [api, collection.name, role, key, failureMessage]);

  const rules = report?.draft.rules.filter((rule) => rule.enabled) || [];
  const legacyTenantIds =
    report?.legacy.tenancy === 'shared' ? [] : [...new Set(report?.legacy.legacyDataTenantIds.map(String) || [])];

  return (
    <Drawer open width={680} title={t('Preview migration')} onClose={onClose}>
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Space direction="vertical" size={0}>
          <Typography.Text strong>{collection.title || collection.name}</Typography.Text>
          <Typography.Text type="secondary">{collection.name}</Typography.Text>
        </Space>
        <Alert
          type="info"
          showIcon
          message={t('This is a migration draft. No new rules have been saved or enabled.')}
        />
        <Button disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {t('Refresh preview')}
        </Button>
        {loading ? <Spin aria-label={t('Loading preview')} /> : null}
        {current?.error ? <Alert type="error" showIcon message={current.error} /> : null}
        {report ? (
          <>
            <Descriptions column={1} bordered size="small">
              <Descriptions.Item label={t('Ownership rules')}>
                {rules.filter((rule) => rule.category === 'ownership').length}
              </Descriptions.Item>
              <Descriptions.Item label={t('Visibility rules')}>
                {rules.filter((rule) => rule.category === 'visibility').length}
              </Descriptions.Item>
            </Descriptions>
            <Typography.Paragraph>{t(modeDescriptions[report.legacy.tenancy])}</Typography.Paragraph>
            <Typography.Paragraph>{t('Visibility rules never grant editing or deletion.')}</Typography.Paragraph>
            {legacyTenantIds.length ? (
              <Space direction="vertical">
                <Typography.Text>{t('Tenants with access to legacy data')}</Typography.Text>
                <Space wrap>
                  {legacyTenantIds.map((id) => {
                    const name = tenantNames.get(id);
                    return <Tag key={id}>{name && name !== id ? `${name} (${id})` : id}</Tag>;
                  })}
                </Space>
                <Typography.Text>
                  {t(
                    report.legacy.allowEditingLegacyData
                      ? 'Allowed edits claim legacy records for the first editor’s tenant.'
                      : 'Legacy records remain read-only.',
                  )}
                </Typography.Text>
              </Space>
            ) : (
              <Typography.Text>{t('No additional legacy data access is granted.')}</Typography.Text>
            )}
            <Typography.Title level={5}>{t('Current role conditions')}</Typography.Title>
            {role ? (
              <>
                <Typography.Text>{role}</Typography.Text>
                <Alert
                  type="warning"
                  showIcon
                  message={t(
                    'Only separate collection grants for the current role are inspected. Other roles, permission strategies, and dynamic grants still need review. This report does not determine final permissions.',
                  )}
                />
                <Table
                  size="small"
                  pagination={false}
                  dataSource={report.roleScopes}
                  rowKey={(entry) => JSON.stringify([entry.role, entry.resource, entry.action])}
                  columns={[
                    {
                      title: t('Action'),
                      dataIndex: 'action',
                      render: (action: string) => t(actionLabels[action] || action),
                    },
                    {
                      title: t('Role conditions after migration'),
                      dataIndex: 'treatment',
                      render: (treatment: string) =>
                        t(treatmentLabels[treatment] || 'Unable to inspect role conditions.'),
                    },
                  ]}
                />
              </>
            ) : (
              <Typography.Text>
                {t('No current role was available, so role conditions were not inspected.')}
              </Typography.Text>
            )}
          </>
        ) : null}
      </Space>
    </Drawer>
  );
}
