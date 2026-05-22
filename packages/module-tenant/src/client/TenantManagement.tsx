import React, { useEffect, useMemo, useState } from 'react';
import { useAPIClient, useRequest } from '@tachybase/client';

import { App, Button, Card, Drawer, Form, Input, Select, Space, Switch, Table, Tag, Typography } from 'antd';

import { useTenantTranslation } from './locale';
import { buildTenantTree, getTenantParentOptions, type TenantRecord } from './tenant-tree';

type UserRecord = {
  id: number;
  username?: string;
  nickname?: string;
  email?: string;
  phone?: string;
  tenants?: TenantRecord[];
  defaultTenantId?: string | null;
};

const formatUserLabel = (user: UserRecord) => {
  const name = user.nickname || user.username || String(user.id);
  const detail = user.email || user.phone || user.username;
  return detail && detail !== name ? `${name} · ${detail}` : name;
};

export const buildUserSearchFilter = (keyword: string) => {
  const value = keyword.trim();
  if (!value) {
    return undefined;
  }

  const filters: any[] = [
    { 'username.$includes': value },
    { 'nickname.$includes': value },
    { 'email.$includes': value },
    { 'phone.$includes': value },
  ];

  if (/^\d+$/.test(value)) {
    filters.push({ id: Number(value) });
  }

  return { $or: filters };
};

export const getTenantMembers = (users: UserRecord[], tenantId?: string | null) => {
  if (!tenantId) {
    return [];
  }

  return users.filter((user) => (user.tenants || []).some((item) => item.id === tenantId));
};

export const getTenantCandidateOptions = (users: UserRecord[], tenantId?: string | null) => {
  if (!tenantId) {
    return [];
  }

  return users
    .filter((user) => !(user.tenants || []).some((item) => item.id === tenantId))
    .map((user) => ({
      label: formatUserLabel(user),
      value: user.id,
    }));
};

type TenantFormValues = {
  name: string;
  title?: string;
  enabled?: boolean;
  parentId?: string | null;
};

export const TenantEditor = ({
  initialValues,
  loading,
  open,
  title,
  parentOptions = [],
  onClose,
  onSubmit,
}: {
  initialValues?: TenantFormValues;
  loading: boolean;
  open: boolean;
  title: string;
  parentOptions?: { label: string; value: string }[];
  onClose: () => void;
  onSubmit: (values: TenantFormValues) => Promise<void>;
}) => {
  const { t } = useTenantTranslation();
  const [form] = Form.useForm<TenantFormValues>();

  useEffect(() => {
    if (!open) {
      form.resetFields();
      return;
    }

    form.setFieldsValue({
      name: initialValues?.name || '',
      title: initialValues?.title || '',
      enabled: initialValues?.enabled ?? true,
      parentId: initialValues?.parentId || null,
    });
  }, [form, initialValues?.enabled, initialValues?.name, initialValues?.parentId, initialValues?.title, open]);

  return (
    <Drawer
      destroyOnClose
      open={open}
      title={title}
      width={420}
      onClose={onClose}
      extra={
        <Space>
          <Button onClick={onClose}>{t('Cancel')}</Button>
          <Button loading={loading} type="primary" onClick={() => form.submit()}>
            {t('Submit')}
          </Button>
        </Space>
      }
    >
      <Form form={form} layout="vertical" onFinish={onSubmit}>
        <Form.Item
          label={t('Tenant key')}
          name="name"
          rules={[{ required: true, message: t('Please enter tenant key') }]}
        >
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item label={t('Tenant name')} name="title">
          <Input autoComplete="off" />
        </Form.Item>
        <Form.Item label={t('Parent tenant')} name="parentId">
          <Select
            allowClear
            options={parentOptions}
            placeholder={t('Select parent tenant')}
            showSearch
            optionFilterProp="label"
          />
        </Form.Item>
        <Form.Item label={t('Enabled')} name="enabled" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Drawer>
  );
};

const TenantMembers = ({
  open,
  tenant,
  onClose,
}: {
  open: boolean;
  tenant: TenantRecord | null;
  onClose: () => void;
}) => {
  const api = useAPIClient();
  const { message } = App.useApp();
  const { t } = useTenantTranslation();
  const [memberKeyword, setMemberKeyword] = useState('');
  const [candidateKeyword, setCandidateKeyword] = useState('');
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const [addingMembers, setAddingMembers] = useState(false);
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([]);

  useEffect(() => {
    if (!open) {
      setMemberKeyword('');
      setCandidateKeyword('');
      setSelectedUserIds([]);
    }
  }, [open, tenant?.id]);

  const membersRequest = useRequest<{ data: UserRecord[] }>(
    () =>
      api
        .resource('users')
        .list({
          pageSize: 200,
          appends: ['tenants', 'defaultTenant'],
          filter: buildUserSearchFilter(memberKeyword),
        })
        .then((res) => res?.data),
    {
      ready: open,
      refreshDeps: [open, memberKeyword],
      debounceWait: 300,
    },
  );

  const candidatesRequest = useRequest<{ data: UserRecord[] }>(
    () =>
      api
        .resource('users')
        .list({
          pageSize: 50,
          appends: ['tenants', 'defaultTenant'],
          filter: buildUserSearchFilter(candidateKeyword),
        })
        .then((res) => res?.data),
    {
      ready: open,
      refreshDeps: [open, candidateKeyword],
      debounceWait: 300,
    },
  );

  const members = useMemo(
    () => getTenantMembers(membersRequest.data?.data || [], tenant?.id),
    [tenant?.id, membersRequest.data?.data],
  );

  const candidateOptions = useMemo(
    () => getTenantCandidateOptions(candidatesRequest.data?.data || [], tenant?.id),
    [tenant?.id, candidatesRequest.data?.data],
  );

  const saveMembership = async (
    user: UserRecord,
    nextTenantIds: string[],
    nextDefaultTenantId?: string | null,
    options: { silent?: boolean; refresh?: boolean } = {},
  ) => {
    setSavingUserId(user.id);
    try {
      await api.resource('users').update({
        filterByTk: user.id,
        values: {
          tenants: nextTenantIds,
          defaultTenantId: nextDefaultTenantId ?? null,
        },
      });
      if (!options.silent) {
        message.success(t('Saved successfully'));
      }
      if (options.refresh !== false) {
        await Promise.all([membersRequest.refresh(), candidatesRequest.refresh()]);
      }
    } finally {
      setSavingUserId(null);
    }
  };

  const addMember = async (userIds: number[]) => {
    if (!tenant?.id) {
      return;
    }

    if (!userIds.length) {
      message.warning(t('Please select users'));
      return;
    }

    setAddingMembers(true);
    try {
      for (const userId of userIds) {
        const user = (candidatesRequest.data?.data || []).find((item) => item.id === userId);
        if (!user) {
          continue;
        }

        const nextTenantIds = Array.from(new Set([...(user.tenants || []).map((item) => item.id), tenant.id]));
        await saveMembership(user, nextTenantIds, user.defaultTenantId || tenant.id, {
          silent: true,
          refresh: false,
        });
      }

      message.success(t('Saved successfully'));
      await Promise.all([membersRequest.refresh(), candidatesRequest.refresh()]);
      setSelectedUserIds([]);
    } finally {
      setAddingMembers(false);
    }
  };

  return (
    <Drawer
      destroyOnClose
      open={open}
      title={tenant ? `${t('Tenant members')} · ${tenant.title || tenant.name}` : t('Tenant members')}
      width={760}
      onClose={onClose}
    >
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Card size="small" title={t('Add member')}>
          <Space.Compact style={{ width: '100%' }}>
            <Select
              allowClear
              filterOption={false}
              loading={candidatesRequest.loading}
              maxTagCount="responsive"
              mode="multiple"
              notFoundContent={t('No users available')}
              options={candidateOptions}
              placeholder={t('Search users')}
              showSearch
              style={{ width: '100%' }}
              value={selectedUserIds}
              onChange={(values) => setSelectedUserIds(values as number[])}
              onSearch={setCandidateKeyword}
            />
            <Button loading={addingMembers} type="primary" onClick={() => void addMember(selectedUserIds)}>
              {t('Add')}
            </Button>
          </Space.Compact>
        </Card>
        <Space style={{ width: '100%', justifyContent: 'space-between' }}>
          <Typography.Text strong>{t('Tenant members')}</Typography.Text>
          <Input.Search
            allowClear
            placeholder={t('Search users')}
            style={{ width: 280 }}
            value={memberKeyword}
            onChange={(event) => setMemberKeyword(event.target.value)}
          />
        </Space>
        <Table<UserRecord>
          loading={membersRequest.loading}
          dataSource={members}
          pagination={false}
          rowKey="id"
          columns={[
            {
              title: t('User'),
              key: 'user',
              render: (_, record) => (
                <Space direction="vertical" size={0}>
                  <Typography.Text strong>{record.nickname || record.username || record.id}</Typography.Text>
                  <Typography.Text type="secondary">{record.email || record.username}</Typography.Text>
                </Space>
              ),
            },
            {
              title: t('Default tenant'),
              key: 'defaultTenantId',
              width: 220,
              render: (_, record) => {
                const options = (record.tenants || []).map((item) => ({
                  label: item.title || item.name || item.id,
                  value: item.id,
                }));
                const nextTenantIds = (record.tenants || []).map((item) => item.id);
                return (
                  <Select
                    allowClear
                    options={options}
                    placeholder={t('Not set')}
                    style={{ width: '100%' }}
                    value={record.defaultTenantId || undefined}
                    onChange={(value) => {
                      void saveMembership(record, nextTenantIds, (value as string) || null);
                    }}
                  />
                );
              },
            },
            {
              title: t('Actions'),
              key: 'actions',
              width: 120,
              render: (_, record) => {
                const nextTenantIds = (record.tenants || []).map((item) => item.id).filter((id) => id !== tenant?.id);
                const nextDefaultTenantId =
                  record.defaultTenantId === tenant?.id ? nextTenantIds[0] || null : record.defaultTenantId;
                return (
                  <Button
                    danger
                    loading={savingUserId === record.id}
                    type="link"
                    onClick={() => {
                      void saveMembership(record, nextTenantIds, nextDefaultTenantId);
                    }}
                  >
                    {t('Remove')}
                  </Button>
                );
              },
            },
          ]}
        />
      </Space>
    </Drawer>
  );
};

export const TenantManagement = () => {
  const api = useAPIClient();
  const { message } = App.useApp();
  const { t } = useTenantTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingTenant, setEditingTenant] = useState<TenantRecord | null>(null);
  const [membersTenant, setMembersTenant] = useState<TenantRecord | null>(null);
  const [saving, setSaving] = useState(false);

  const tenantsRequest = useRequest<{ data: TenantRecord[] }>(() =>
    api
      .resource('tenants')
      .list({
        pageSize: 200,
      })
      .then((res) => res?.data),
  );

  const tenants = useMemo(() => tenantsRequest.data?.data || [], [tenantsRequest.data?.data]);
  const tenantTree = useMemo(() => buildTenantTree(tenants), [tenants]);
  const parentOptions = useMemo(() => getTenantParentOptions(tenants, editingTenant), [editingTenant, tenants]);

  const submitTenant = async (values: TenantFormValues) => {
    setSaving(true);
    try {
      const normalizedValues = {
        ...values,
        parentId: values.parentId || null,
      };

      if (editingTenant?.id) {
        await api.resource('tenants').update({
          filterByTk: editingTenant.id,
          values: normalizedValues,
        });
      } else {
        await api.resource('tenants').create({
          values: normalizedValues,
        });
      }
      message.success(t('Saved successfully'));
      setDrawerOpen(false);
      setEditingTenant(null);
      await tenantsRequest.refresh();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <Space direction="vertical" size={16} style={{ display: 'flex' }}>
        <Space style={{ justifyContent: 'space-between', width: '100%' }}>
          <div>
            <Typography.Title level={4} style={{ margin: 0 }}>
              {t('Tenant management')}
            </Typography.Title>
            <Typography.Text type="secondary">
              {t('Create tenants, control status, and manage members here.')}
            </Typography.Text>
          </div>
          <Button
            type="primary"
            onClick={() => {
              setEditingTenant(null);
              setDrawerOpen(true);
            }}
          >
            {t('Add tenant')}
          </Button>
        </Space>
        <Table<TenantRecord>
          loading={tenantsRequest.loading}
          dataSource={tenantTree}
          pagination={false}
          rowKey="id"
          columns={[
            {
              title: t('Tenant key'),
              dataIndex: 'name',
              key: 'name',
            },
            {
              title: t('Tenant name'),
              key: 'title',
              render: (_, record) => record.title || <Typography.Text type="secondary">{t('Not set')}</Typography.Text>,
            },
            {
              title: t('Status'),
              key: 'enabled',
              width: 120,
              render: (_, record) =>
                record.enabled === false ? <Tag>{t('Disabled')}</Tag> : <Tag color="success">{t('Enabled')}</Tag>,
            },
            {
              title: t('Actions'),
              key: 'actions',
              width: 280,
              render: (_, record) => (
                <Space size={4}>
                  <Button
                    type="link"
                    onClick={() => {
                      setEditingTenant(record);
                      setDrawerOpen(true);
                    }}
                  >
                    {t('Edit')}
                  </Button>
                  <Button
                    type="link"
                    onClick={() => {
                      setMembersTenant(record);
                    }}
                  >
                    {t('Members')}
                  </Button>
                  <Switch
                    checked={record.enabled !== false}
                    size="small"
                    onChange={async (checked) => {
                      await api.resource('tenants').update({
                        filterByTk: record.id,
                        values: { enabled: checked },
                      });
                      message.success(t('Saved successfully'));
                      await tenantsRequest.refresh();
                    }}
                  />
                </Space>
              ),
            },
          ]}
        />
      </Space>
      <TenantEditor
        initialValues={editingTenant || undefined}
        loading={saving}
        open={drawerOpen}
        parentOptions={parentOptions}
        title={editingTenant ? t('Edit tenant') : t('Add tenant')}
        onClose={() => {
          setDrawerOpen(false);
          setEditingTenant(null);
        }}
        onSubmit={submitTenant}
      />
      <TenantMembers open={!!membersTenant} tenant={membersTenant} onClose={() => setMembersTenant(null)} />
    </Card>
  );
};

export default TenantManagement;
