import React from 'react';

import { Button, Input, Select, Space, Switch, Typography } from 'antd';

import type { AccessCondition, AccessOperand } from '../server/access-control/types';
import { useTenantTranslation } from './locale';
import { TenantAccessOperandEditor } from './TenantAccessOperandEditor';

const conditionLabels: Record<AccessCondition['type'], string> = {
  constant: 'Constant condition',
  all: 'All conditions must match',
  any: 'Any condition may match',
  not: 'Must not match',
  compare: 'Compare values',
  isNull: 'Value is empty (null)',
  exists: 'Related record exists',
  tenantRelation: 'Tenant relationship',
};
const operators = {
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
const noMatch = (): AccessCondition => ({ type: 'constant', value: false });

interface ConditionProps {
  value: AccessCondition;
  onChange: (value: AccessCondition) => void;
  label: string;
  subject?: boolean;
  disabled?: boolean;
  depth?: number;
}

/** Edit only the condition AST. Metadata and operator compatibility remain server-validated. */
export function TenantAccessConditionEditor({
  value,
  onChange,
  label,
  subject = false,
  disabled,
  depth = 0,
}: ConditionProps) {
  const { t } = useTenantTranslation();
  const name = (key: string) => `${label} / ${t(key)}`;
  const operand = (
    next: AccessOperand,
    change: (next: AccessOperand) => void,
    suffix?: string,
    allowField = !subject,
  ) => (
    <TenantAccessOperandEditor
      value={next}
      onChange={change}
      label={suffix ? name(suffix) : label}
      allowField={allowField}
      disabled={disabled}
    />
  );
  const child = (next: AccessCondition, change: (next: AccessCondition) => void, suffix: string) => (
    <TenantAccessConditionEditor
      value={next}
      onChange={change}
      label={`${label} / ${suffix}`}
      subject={subject}
      disabled={disabled}
      depth={depth + 1}
    />
  );
  const replace = (type: AccessCondition['type']) => {
    const defaultOperand: AccessOperand = subject
      ? { type: 'context', path: 'tenant.id' }
      : { type: 'field', path: '' };
    switch (type) {
      case 'constant':
        return onChange(noMatch());
      case 'all':
      case 'any':
        return onChange({ type, children: [noMatch()] });
      // A negated true condition initially matches nothing.
      case 'not':
        return onChange({ type, child: { type: 'constant', value: true } });
      case 'compare':
        return onChange({ type, operator: 'eq', left: defaultOperand, right: { type: 'literal', value: '' } });
      case 'isNull':
        return onChange({ type, operand: defaultOperand });
      case 'exists':
        return onChange({ type, path: '', condition: noMatch() });
      case 'tenantRelation':
        return onChange({ type, tenant: defaultOperand, relation: 'same', includeSelf: false });
    }
  };
  return (
    <section aria-label={label} style={{ borderLeft: '2px solid #eee', paddingLeft: 12, marginBottom: 12 }}>
      <Space direction="vertical" style={{ display: 'flex' }}>
        <Select
          aria-label={name('Condition type')}
          value={value.type}
          disabled={disabled}
          style={{ width: '100%' }}
          options={Object.entries(conditionLabels)
            .filter(
              ([type]) =>
                (!subject || type !== 'exists') && (depth < 16 || !['all', 'any', 'not', 'exists'].includes(type)),
            )
            .map(([type, text]) => ({ value: type, label: t(text) }))}
          onChange={replace}
        />
        {value.type === 'constant' ? (
          <Space>
            <Typography.Text>{t('Condition matches')}</Typography.Text>
            <Switch
              aria-label={name('Condition matches')}
              checked={value.value}
              disabled={disabled}
              onChange={(next) => onChange({ ...value, value: next })}
            />
          </Space>
        ) : null}
        {value.type === 'all' || value.type === 'any' ? (
          <>
            {value.children.map((item, index) => (
              <div key={index}>
                {child(
                  item,
                  (next) =>
                    onChange({
                      ...value,
                      children: value.children.map((existing, position) => (index === position ? next : existing)),
                    }),
                  `${t('Condition')} ${index + 1}`,
                )}
                <Button
                  disabled={disabled || value.children.length === 1}
                  aria-label={`${label} / ${t('Remove condition')} ${index + 1}`}
                  onClick={() =>
                    onChange({ ...value, children: value.children.filter((_, position) => index !== position) })
                  }
                >
                  {t('Remove condition')}
                </Button>
              </div>
            ))}
            <Button
              disabled={disabled || value.children.length >= 1000 || depth >= 16}
              aria-label={name('Add condition')}
              onClick={() => onChange({ ...value, children: [...value.children, noMatch()] })}
            >
              {t('Add condition')}
            </Button>
          </>
        ) : null}
        {value.type === 'not'
          ? child(value.child, (next) => onChange({ ...value, child: next }), t('Negated condition'))
          : null}
        {value.type === 'isNull' ? operand(value.operand, (next) => onChange({ ...value, operand: next })) : null}
        {value.type === 'compare' ? (
          <>
            {operand(value.left, (next) => onChange({ ...value, left: next }), 'Left value')}
            <Select
              aria-label={name('Comparison operator')}
              disabled={disabled}
              value={value.operator}
              style={{ minWidth: 180 }}
              options={Object.entries(operators).map(([operator, text]) => ({ value: operator, label: t(text) }))}
              onChange={(operator) => onChange({ ...value, operator })}
            />
            {operand(value.right, (next) => onChange({ ...value, right: next }), 'Right value', false)}
          </>
        ) : null}
        {value.type === 'exists' ? (
          <>
            <Input
              aria-label={name('Association path')}
              value={value.path}
              disabled={disabled}
              onChange={(event) => onChange({ ...value, path: event.target.value })}
            />
            {child(value.condition, (next) => onChange({ ...value, condition: next }), t('Related records'))}
          </>
        ) : null}
        {value.type === 'tenantRelation' ? (
          <>
            {operand(value.tenant, (next) => onChange({ ...value, tenant: next }))}
            <Select
              aria-label={name('Current tenant relationship')}
              value={value.relation}
              disabled={disabled}
              style={{ width: '100%' }}
              options={[
                { value: 'same', label: t('Same as the specified tenant') },
                { value: 'ancestor', label: t('Ancestor of the specified tenant') },
                { value: 'descendant', label: t('Descendant of the specified tenant') },
              ]}
              onChange={(relation) => onChange({ ...value, relation })}
            />
            <Space>
              <Typography.Text>{t('Include specified tenant')}</Typography.Text>
              <Switch
                aria-label={name('Include specified tenant')}
                checked={value.includeSelf}
                disabled={disabled}
                onChange={(includeSelf) => onChange({ ...value, includeSelf })}
              />
            </Space>
            <Typography.Text type="secondary">
              {t(
                'The relationship describes the current tenant relative to the specified tenant. Empty tenant values do not match, including under negation.',
              )}
            </Typography.Text>
          </>
        ) : null}
      </Space>
    </section>
  );
}
