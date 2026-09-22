import { ACL } from '@tego/server';

import { guardUnsupportedAssociationReadScopes, resolveAssociationReadScope } from '../helpers/association-read-scope';

describe('association target read scope', () => {
  it('rejects a scoped relation used only in a singular sort value on an old core', () => {
    const project = { ...target, model: { name: 'projects' } };
    const source: any = {
      model: { associations: { projects: { target: project.model, isSingleAssociation: false } } },
    };
    const db = { modelCollection: new Map([[project.model, project]]) };
    const ctx = {
      action: { params: { sort: '-projects.title' } },
      can: () => ({ params: {} }),
      throw: (_status: number, message: string) => {
        throw new Error(message);
      },
    };
    expect(() => guardUnsupportedAssociationReadScopes(ctx, db, source, {})).toThrow('database version');
  });

  it('allows a plain shared append when only its nested appends are restricted', () => {
    const sharedModel = { name: 'sharedTarget' };
    const shared = { name: 'sharedTarget', model: sharedModel, options: { tenancy: 'shared' } };
    const source: any = { model: { associations: { target: { target: sharedModel } } } };
    const db = { modelCollection: new Map([[sharedModel, shared]]) };
    const ctx = {
      action: { params: { appends: ['target'] } },
      can: () => ({ params: { appends: [] } }),
      throw: (_status: number, message: string) => {
        throw new Error(message);
      },
    };
    expect(() => guardUnsupportedAssociationReadScopes(ctx, db, source, {})).not.toThrow();
  });

  it('uses the association resource when checking shared appends on an old core', () => {
    const sharedModel = { name: 'flow_nodes' };
    const shared = { name: 'flow_nodes', model: sharedModel, options: { tenancy: 'shared' } };
    const source: any = {
      name: 'workflows',
      model: {
        associations: {
          nodes: { as: 'nodes', source: { name: 'workflows' }, target: sharedModel },
        },
      },
    };
    const db = { modelCollection: new Map([[sharedModel, shared]]) };
    const can = vi.fn(({ rawResourceName }: any) => (rawResourceName === 'workflows.nodes' ? { params: {} } : null));
    const ctx = {
      action: { params: { appends: ['nodes'] } },
      can,
      throw: (_status: number, message: string) => {
        throw new Error(message);
      },
    };

    expect(() => guardUnsupportedAssociationReadScopes(ctx, db, source, {})).not.toThrow();
    expect(can).toHaveBeenCalledWith({
      resource: 'flow_nodes',
      action: 'list',
      rawResourceName: 'workflows.nodes',
    });
  });

  it('rejects nested paths forbidden by the shared target ACL on an old core', () => {
    const sharedModel = { name: 'sharedTarget' };
    const shared = { name: 'sharedTarget', model: sharedModel, options: { tenancy: 'shared' } };
    const source: any = { model: { associations: { target: { target: sharedModel } } } };
    const db = { modelCollection: new Map([[sharedModel, shared]]) };
    const ctx = {
      action: { params: { appends: ['target.secret'] } },
      can: () => ({ params: { appends: [] } }),
      throw: (_status: number, message: string) => {
        throw new Error(message);
      },
    };
    expect(() => guardUnsupportedAssociationReadScopes(ctx, db, source, {})).toThrow('database version');
  });

  it('rejects a deeper path than the old-core ACL append grant', () => {
    const targetModel = { name: 'target' };
    const ownerModel = { name: 'owner' };
    targetModel['associations'] = { owner: { target: ownerModel } };
    const targetCollection = { name: 'target', model: targetModel, options: { tenancy: 'shared' } };
    const ownerCollection = { name: 'owner', model: ownerModel, options: { tenancy: 'shared' } };
    const source: any = { model: { associations: { target: { target: targetModel } } } };
    const db = {
      modelCollection: new Map([
        [targetModel, targetCollection],
        [ownerModel, ownerCollection],
      ]),
    };
    const ctx = {
      action: { params: { appends: ['target.owner.secret'] } },
      can: ({ resource }: any) => ({ params: resource === 'target' ? { appends: ['owner.name'] } : {} }),
      throw: (_status: number, message: string) => {
        throw new Error(message);
      },
    };
    expect(() => guardUnsupportedAssociationReadScopes(ctx, db, source, {})).toThrow('database version');
    ctx.action.params.appends = ['target.owner.name'];
    expect(() => guardUnsupportedAssociationReadScopes(ctx, db, source, {})).not.toThrow();
  });
  const acl = {
    filterParams: (_ctx: any, _name: string, params: any) => params,
    parseJsonTemplate: async (params: any) => params,
  };
  const target = {
    name: 'projects',
    model: { primaryKeyAttribute: 'id' },
    options: { tenancy: 'tenantInherited', legacyDataTenantIds: [] },
  };

  it('ignores the core internal pivot used to constrain a direct many-to-many query', async () => {
    const scope = await resolveAssociationReadScope(
      { state: {}, can: () => null },
      target,
      { as: '_pivot_', options: { realAs: 'read_companies_projects' } },
      acl,
    );

    expect(scope).toBeUndefined();
  });

  it('combines the target ACL and its own tenant visibility', async () => {
    const ctx = {
      state: { currentTenantId: 'parent', currentTenantDescendantIds: ['child'] },
      can: () => ({ params: { filter: { status: 'open' }, fields: ['id', 'title'] } }),
    };

    const scope = await resolveAssociationReadScope(ctx, target, { isSingleAssociation: false }, acl);
    expect(scope).toEqual({
      filter: { $and: [{ status: 'open' }, { tenantId: { $in: ['parent', 'child'] } }] },
      fields: ['id', 'title'],
      appends: undefined,
    });
  });

  it('uses the source association resource when resolving target ACL snippets', async () => {
    const can = vi.fn(({ rawResourceName }: any) => (rawResourceName === 'workflows.nodes' ? { params: {} } : null));

    const scope = await resolveAssociationReadScope(
      { state: {}, can },
      { ...target, name: 'flow_nodes', options: { tenancy: 'shared' } },
      { as: 'nodes', source: { name: 'workflows' }, isSingleAssociation: false },
      acl,
    );

    expect(can).toHaveBeenCalledWith({
      resource: 'flow_nodes',
      action: 'list',
      rawResourceName: 'workflows.nodes',
    });
    expect(scope).toEqual({ filter: undefined, fields: undefined, appends: undefined });
  });

  it('honors logged-in allow rules declared for an association resource', async () => {
    const realAcl = new ACL();
    realAcl.allow('approvalRecords.workflow', 'get', 'loggedIn');
    const ctx = {
      state: { currentUser: { id: 8 } },
      can: () => null,
    };

    const scope = await resolveAssociationReadScope(
      ctx,
      { ...target, name: 'workflows', options: { tenancy: 'shared' } },
      { as: 'workflow', source: { name: 'approvalRecords' }, isSingleAssociation: true },
      realAcl,
    );

    expect(scope).toEqual({ filter: undefined, fields: undefined, appends: undefined });
  });

  it('denies allow rules safely when an internal context has no state', async () => {
    const realAcl = new ACL();
    realAcl.allow('*', '*', (ctx) => ctx.state.currentRole === 'root');

    const scope = await resolveAssociationReadScope(
      { can: () => null },
      { ...target, options: { tenancy: 'shared' } },
      { isSingleAssociation: false },
      realAcl,
    );

    expect(scope).toEqual({ filter: { id: { $in: [] } }, fields: [], appends: [] });
  });

  it('fails closed when an ACL allow condition cannot evaluate an internal context', async () => {
    const throwingAcl = {
      filterParams: acl.filterParams,
      parseJsonTemplate: acl.parseJsonTemplate,
      allowManager: {
        isAllowed: vi.fn(async () => {
          throw new TypeError("Cannot read properties of undefined (reading 'currentRole')");
        }),
      },
    };

    await expect(
      resolveAssociationReadScope(
        { state: {}, can: () => null },
        { ...target, options: { tenancy: 'shared' } },
        { isSingleAssociation: false },
        throwingAcl,
      ),
    ).resolves.toEqual({ filter: { id: { $in: [] } }, fields: [], appends: [] });
  });

  it('keeps explicit target ACL rules ahead of association snippets', async () => {
    const realAcl = new ACL();
    realAcl.registerSnippet({ name: 'pm.workflow', actions: ['workflows.nodes:list'] });
    const role = realAcl.define({ role: 'developer' });
    role.snippets.add('pm.workflow');
    const ctx = {
      state: {},
      can: (options: any) => realAcl.can({ role: 'developer', ...options }),
    };
    const sharedTarget = { ...target, name: 'flow_nodes', options: { tenancy: 'shared' } };
    const association = { as: 'nodes', source: { name: 'workflows' }, isSingleAssociation: false };

    await expect(resolveAssociationReadScope(ctx, sharedTarget, association, realAcl)).resolves.toEqual({
      filter: undefined,
      fields: undefined,
      appends: undefined,
    });

    role.grantAction('flow_nodes:create');
    await expect(resolveAssociationReadScope(ctx, sharedTarget, association, realAcl)).resolves.toEqual({
      filter: { id: { $in: [] } },
      fields: [],
      appends: [],
    });
  });

  it('does not grant a target merely because the source is readable', async () => {
    const scope = await resolveAssociationReadScope({ state: {}, can: () => null }, target, {}, acl);
    expect(scope.filter).toEqual({ id: { $in: [] } });
    expect(scope.fields).toEqual([]);
  });

  it('leaves a shared target unfiltered while preserving its ACL scope', async () => {
    const scope = await resolveAssociationReadScope(
      { state: { currentTenantId: 'parent' }, can: () => ({ params: { filter: { enabled: true } } }) },
      { ...target, options: { tenancy: 'shared' } },
      { isSingleAssociation: true },
      acl,
    );
    expect(scope.filter).toEqual({ enabled: true });
  });
});
