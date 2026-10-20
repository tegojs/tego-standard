import React, { useState } from 'react';
import { fireEvent, render } from '@tachybase/test/client';

import type { AccessCondition } from '../../server/access-control/types';
import { TenantAccessConditionEditor } from '../TenantAccessConditionEditor';

function fixture(initial: AccessCondition, subject = false, disabled = false) {
  const change = vi.fn();
  function View() {
    const [value, setValue] = useState(initial);
    return (
      <TenantAccessConditionEditor
        value={value}
        label="Rule"
        subject={subject}
        disabled={disabled}
        onChange={(next) => {
          change(next);
          setValue(next);
        }}
      />
    );
  }
  return { ...render(<View />), change };
}

describe('tenant access condition editor', () => {
  it('disables nested structure and operand controls while validation is pending', () => {
    const { getAllByRole } = fixture(
      {
        type: 'any',
        children: [
          {
            type: 'compare',
            operator: 'in',
            left: { type: 'field', path: 'id' },
            right: { type: 'literal', value: [1, 2] },
          },
        ],
      },
      false,
      true,
    );
    for (const role of ['button', 'combobox', 'textbox', 'spinbutton'])
      for (const control of getAllByRole(role)) expect(control).toBeDisabled();
  });

  it('uses a non-matching initial condition when replacing a node with negation', async () => {
    const { getByRole, findByText, change } = fixture({ type: 'constant', value: true });
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule / Condition type' }));
    fireEvent.click(await findByText('Must not match'));
    expect(change.mock.lastCall?.[0]).toEqual({ type: 'not', child: { type: 'constant', value: true } });
    fireEvent.click(getByRole('switch', { name: 'Rule / Negated condition / Condition matches' }));
    expect(change.mock.lastCall?.[0].child.value).toBe(false);
  });

  it('changes scalar literal types explicitly and does not offer fields on the right', async () => {
    const { getByRole, findByText, change } = fixture({
      type: 'compare',
      operator: 'eq',
      left: { type: 'field', path: 'id' },
      right: { type: 'literal', value: '001' },
    });
    fireEvent.change(getByRole('textbox', { name: 'Rule / Right value / Fixed value' }), { target: { value: '002' } });
    expect(change.mock.lastCall?.[0].right.value).toBe('002');
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule / Right value / Value type' }));
    fireEvent.click(await findByText('Boolean value'));
    fireEvent.click(getByRole('switch', { name: 'Rule / Right value / Fixed value' }));
    expect(change.mock.lastCall?.[0].right.value).toBe(true);
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule / Right value / Value source' }));
    expect(document.querySelector('.ant-select-dropdown:not(.ant-select-dropdown-hidden)')?.textContent).not.toContain(
      'Record field',
    );
    fireEvent.click(await findByText('Identity variable'));
    expect(change.mock.lastCall?.[0].right).toEqual({ type: 'context', path: 'tenant.id' });
  });

  it.each([false, true])('retains numeric input type when cleared and retyped (list: %s)', (list) => {
    const { getByRole, change } = fixture({
      type: 'compare',
      operator: list ? 'in' : 'eq',
      left: { type: 'field', path: 'id' },
      right: { type: 'literal', value: list ? [12] : 12 },
    });
    const label = list ? 'Rule / Right value / Item 1 / Fixed value' : 'Rule / Right value / Fixed value';
    fireEvent.change(getByRole('spinbutton', { name: label }), { target: { value: '' } });
    expect(getByRole('spinbutton', { name: label })).toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    fireEvent.change(getByRole('spinbutton', { name: label }), { target: { value: '34' } });
    expect(change.mock.lastCall?.[0].right.value).toEqual(list ? [34] : 34);
  });

  it('edits a nested association without mutating the original tree', () => {
    const initial: AccessCondition = {
      type: 'exists',
      path: 'participants',
      condition: {
        type: 'all',
        children: [{ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
      },
    };
    const { getByRole, change } = fixture(initial);
    fireEvent.change(getByRole('textbox', { name: 'Rule / Related records / Condition 1 / Field path' }), {
      target: { value: 'businessTenantId' },
    });
    expect(change.mock.lastCall?.[0].condition.children[0].operand.path).toBe('businessTenantId');
    expect(initial.condition).toEqual({
      type: 'all',
      children: [{ type: 'isNull', operand: { type: 'field', path: 'tenantId' } }],
    });
    fireEvent.change(getByRole('textbox', { name: 'Rule / Association path' }), { target: { value: 'organizations' } });
    expect(change.mock.lastCall?.[0].path).toBe('organizations');
  });

  it('adds and removes grouped conditions but keeps one child', () => {
    const { getByRole, getAllByRole, change } = fixture({
      type: 'all',
      children: [{ type: 'constant', value: false }],
    });
    expect(getByRole('button', { name: 'Rule / Remove condition 1' })).toBeDisabled();
    fireEvent.click(getByRole('button', { name: 'Rule / Add condition' }));
    expect(change.mock.lastCall?.[0].children).toHaveLength(2);
    fireEvent.click(getByRole('button', { name: 'Rule / Remove condition 1' }));
    expect(change.mock.lastCall?.[0].children).toEqual([{ type: 'constant', value: false }]);
    expect(getAllByRole('switch')).toHaveLength(1);
  });

  it('restricts visitor conditions to identity values and excludes associations', async () => {
    const { getByRole, findByText, queryByText } = fixture({ type: 'constant', value: false }, true);
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule / Condition type' }));
    expect(queryByText('Related record exists')).not.toBeInTheDocument();
    fireEvent.click(await findByText('Compare values'));
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule / Left value / Value source' }));
    expect(queryByText('Record field')).not.toBeInTheDocument();
    expect(getByRole('combobox', { name: 'Rule / Right value / Value source' })).toBeInTheDocument();
  });

  it('edits the visitor direction and self-inclusion in a tenant relationship', async () => {
    const { getByRole, findByText, change } = fixture({
      type: 'tenantRelation',
      tenant: { type: 'field', path: 'tenantId' },
      relation: 'ancestor',
      includeSelf: true,
    });
    fireEvent.click(getByRole('switch', { name: 'Rule / Include specified tenant' }));
    expect(change.mock.lastCall?.[0].includeSelf).toBe(false);
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule / Current tenant relationship' }));
    fireEvent.click(await findByText('Descendant of the specified tenant'));
    expect(change.mock.lastCall?.[0].relation).toBe('descendant');
  });

  it('preserves typed literal list values and edits an item', () => {
    const { getByRole, change } = fixture({
      type: 'compare',
      operator: 'in',
      left: { type: 'field', path: 'id' },
      right: { type: 'literal', value: [1, 2] },
    });
    fireEvent.change(getByRole('spinbutton', { name: 'Rule / Right value / Item 2 / Fixed value' }), {
      target: { value: '3' },
    });
    expect(change.mock.lastCall?.[0].right.value).toEqual([1, 3]);
    expect(change.mock.lastCall?.[0].operator).toBe('in');
  });

  it('replaces a condition with a safe non-matching default', async () => {
    const { getByRole, findByText, change } = fixture({ type: 'constant', value: true });
    fireEvent.mouseDown(getByRole('combobox', { name: 'Rule / Condition type' }));
    fireEvent.click(await findByText('All conditions must match'));
    expect(change.mock.lastCall?.[0]).toEqual({ type: 'all', children: [{ type: 'constant', value: false }] });
  });
});
