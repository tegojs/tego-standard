import { captureWorkflowAccessIdentity } from '../../access-control/workflow-identity';

describe('trusted workflow access identity', () => {
  it('captures the canonical tenant, persisted user and role as an immutable identity', () => {
    const state = { currentTenantId: 'B', currentUserId: 28, currentRole: 'worker' };
    const identity = captureWorkflowAccessIdentity({ state });
    expect(identity).toEqual({ tenantId: 'B', userId: '28', roleName: 'worker' });
    state.currentTenantId = 'C';
    state.currentUserId = 99;
    state.currentRole = 'admin';
    expect(identity).toEqual({ tenantId: 'B', userId: '28', roleName: 'worker' });
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('keeps automatic execution tenant-only without inventing a human identity', () => {
    expect(captureWorkflowAccessIdentity({ state: { currentTenantId: 42 } })).toEqual({ tenantId: '42' });
  });

  it('keeps a trusted role without requiring a user or tenant', () => {
    expect(captureWorkflowAccessIdentity({ state: { currentRole: 'worker' } })).toEqual({ roleName: 'worker' });
  });

  it.each([{}, { currentTenantId: null, currentUserId: undefined, currentRole: null }])(
    'allows missing identity for explicitly identity-free rules: %j',
    (state) => {
      expect(captureWorkflowAccessIdentity({ state })).toEqual({});
    },
  );

  it('does not borrow identity from payloads, headers or current-user/current-tenant aliases', () => {
    expect(
      captureWorkflowAccessIdentity({
        headers: { 'x-tenant-id': 'C', 'x-role': 'admin' },
        data: { currentTenantId: 'C', currentUserId: 99, currentRole: 'admin' },
        state: {
          currentTenant: { id: 'C' },
          currentUser: { id: 99 },
          tenantContext: { currentTenantId: 'C' },
          authContext: { currentUserId: 99, currentRole: 'admin' },
        },
      }),
    ).toEqual({});
  });

  it('uses canonical persisted IDs even when transient aliases disagree', () => {
    expect(
      captureWorkflowAccessIdentity({
        state: {
          currentTenantId: 'B',
          currentTenant: { id: 'C' },
          currentUserId: 28,
          currentUser: { id: 99 },
          currentRole: 'worker',
        },
      }),
    ).toEqual({ tenantId: 'B', userId: '28', roleName: 'worker' });
  });

  it('accepts plain state without a prototype', () => {
    const state = Object.assign(Object.create(null), { currentTenantId: 'B', currentUserId: 28 });
    expect(captureWorkflowAccessIdentity(Object.assign(Object.create(null), { state }))).toEqual({
      tenantId: 'B',
      userId: '28',
    });
  });

  it.each([null, undefined, [], 'B', {}, { state: null }, { state: [] }, { state: 'B' }])(
    'rejects an unavailable or malformed Processor context: %j',
    (context) => {
      expect(() => captureWorkflowAccessIdentity(context)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ACCESS_CONTEXT' }),
      );
    },
  );

  it('does not inherit identity or state from another object', () => {
    for (const context of [
      Object.create({ state: { currentTenantId: 'B' } }),
      { state: Object.create({ currentTenantId: 'B' }) },
    ]) {
      expect(() => captureWorkflowAccessIdentity(context)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ACCESS_CONTEXT' }),
      );
    }
  });

  it.each(['state', 'currentTenantId', 'currentUserId', 'currentRole'])(
    'rejects the %s accessor without executing it',
    (field) => {
      let calls = 0;
      const context = { state: {} };
      Object.defineProperty(field === 'state' ? context : context.state, field, {
        get: () => {
          calls++;
          return 'B';
        },
      });
      expect(() => captureWorkflowAccessIdentity(context)).toThrowError(
        expect.objectContaining({ code: 'MISSING_ACCESS_CONTEXT' }),
      );
      expect(calls).toBe(0);
    },
  );

  it('does not evaluate unrelated context properties', () => {
    const context = { state: { currentTenantId: 'B' } };
    for (const target of [context, context.state]) {
      Object.defineProperty(target, 'unrelated', {
        get: () => {
          throw new Error('must not read');
        },
      });
    }
    expect(captureWorkflowAccessIdentity(context)).toEqual({ tenantId: 'B' });
  });

  it.each([
    ['currentTenantId', ''],
    ['currentTenantId', false],
    ['currentTenantId', Number.MAX_SAFE_INTEGER + 1],
    ['currentTenantId', 'B'.repeat(10001)],
    ['currentUserId', {}],
    ['currentUserId', 1.5],
    ['currentUserId', Infinity],
    ['currentRole', ''],
    ['currentRole', 28],
    ['currentRole', 'a'.repeat(257)],
  ])('rejects malformed canonical %s rather than ignoring it', (field, value) => {
    expect(() => captureWorkflowAccessIdentity({ state: { [field]: value } })).toThrowError(
      expect.objectContaining({ code: 'MISSING_ACCESS_CONTEXT' }),
    );
  });
});
