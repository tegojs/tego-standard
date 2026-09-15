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
