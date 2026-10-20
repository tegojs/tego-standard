import React from 'react';

import { Button, Input, InputNumber, Select, Space, Switch, Typography } from 'antd';

import type { AccessOperand, ContextPath, Scalar } from '../server/access-control/types';
import { useTenantTranslation } from './locale';

const contexts: Record<ContextPath, string> = {
  'tenant.id': 'Current tenant',
  'user.id': 'Current user',
  'role.name': 'Current role',
  'tenant.ancestorIds': 'Current tenant ancestors',
  'tenant.descendantIds': 'Current tenant descendants',
};
const literalLabels: Record<string, string> = {
  string: 'Text value',
  number: 'Number value',
  boolean: 'Boolean value',
  null: 'Empty value (null)',
  list: 'Value list',
};

function LiteralEditor({
  value,
  onChange,
  label,
  disabled,
  allowList = true,
}: {
  value: Scalar | Scalar[];
  onChange: (value: Scalar | Scalar[]) => void;
  label: string;
  disabled?: boolean;
  allowList?: boolean;
}) {
  const { t } = useTenantTranslation();
  const name = (key: string) => `${label} / ${t(key)}`;
  const type = Array.isArray(value) ? 'list' : value === null ? 'null' : typeof value;
  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      <Select
        aria-label={name('Value type')}
        value={type}
        disabled={disabled}
        style={{ minWidth: 150 }}
        options={['string', 'number', 'boolean', 'null', ...(allowList ? ['list'] : [])].map((item) => ({
          value: item,
          label: t(literalLabels[item]),
        }))}
        onChange={(next) =>
          onChange(
            next === 'list' ? [''] : next === 'number' ? 0 : next === 'boolean' ? false : next === 'null' ? null : '',
          )
        }
      />
      {typeof value === 'string' ? (
        <Input
          aria-label={name('Fixed value')}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
      {typeof value === 'number' ? (
        <InputNumber
          aria-label={name('Fixed value')}
          value={value}
          disabled={disabled}
          onChange={(next) => {
            // Clearing the input is temporary; null requires an explicit type change.
            if (next !== null) onChange(next);
          }}
        />
      ) : null}
      {typeof value === 'boolean' ? (
        <Switch aria-label={name('Fixed value')} checked={value} disabled={disabled} onChange={onChange} />
      ) : null}
      {value === null ? <Typography.Text>{t('Empty value (null)')}</Typography.Text> : null}
      {Array.isArray(value) ? (
        <>
          {value.map((item, index) => (
            <Space key={index} align="start">
              <LiteralEditor
                value={item}
                allowList={false}
                disabled={disabled}
                label={`${label} / ${t('Item')} ${index + 1}`}
                onChange={(next) => {
                  if (!Array.isArray(next))
                    onChange(value.map((existing, position) => (index === position ? next : existing)));
                }}
              />
              <Button
                disabled={disabled || value.length === 1}
                aria-label={`${label} / ${t('Remove item')} ${index + 1}`}
                onClick={() => onChange(value.filter((_, position) => index !== position))}
              >
                {t('Remove item')}
              </Button>
            </Space>
          ))}
          <Button
            disabled={disabled || value.length >= 1000}
            aria-label={name('Add item')}
            onClick={() => onChange([...value, ''])}
          >
            {t('Add item')}
          </Button>
        </>
      ) : null}
    </Space>
  );
}

interface OperandProps {
  value: AccessOperand;
  onChange: (value: AccessOperand) => void;
  label: string;
  allowField: boolean;
  disabled?: boolean;
}

export function TenantAccessOperandEditor({ value, onChange, label, allowField, disabled }: OperandProps) {
  const { t } = useTenantTranslation();
  const name = (key: string) => `${label} / ${t(key)}`;
  return (
    <Space direction="vertical" style={{ display: 'flex' }}>
      <Select
        aria-label={name('Value source')}
        value={value.type}
        disabled={disabled}
        style={{ minWidth: 180 }}
        options={[
          ...(allowField ? [{ value: 'field', label: t('Record field') }] : []),
          { value: 'context', label: t('Identity variable') },
          { value: 'literal', label: t('Fixed value') },
        ]}
        onChange={(type) =>
          onChange(
            type === 'field'
              ? { type, path: '' }
              : type === 'context'
                ? { type, path: 'tenant.id' }
                : { type: 'literal', value: '' },
          )
        }
      />
      {value.type === 'field' ? (
        <Input
          aria-label={name('Field path')}
          value={value.path}
          disabled={disabled}
          onChange={(event) => onChange({ ...value, path: event.target.value })}
        />
      ) : null}
      {value.type === 'context' ? (
        <Select
          aria-label={name('Identity variable')}
          value={value.path}
          disabled={disabled}
          style={{ minWidth: 200 }}
          options={Object.entries(contexts).map(([path, text]) => ({ value: path, label: t(text) }))}
          onChange={(path: ContextPath) => onChange({ type: 'context', path })}
        />
      ) : null}
      {value.type === 'literal' ? (
        <LiteralEditor
          value={value.value}
          label={label}
          disabled={disabled}
          onChange={(next) => onChange({ type: 'literal', value: next })}
        />
      ) : null}
    </Space>
  );
}
