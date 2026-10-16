import type { Collection, Database } from '@tego/server';

import { AccessReadSelectionParser } from '../../access-control/read-selection';
import type { AccessFilterReadGrant } from '../../access-control/request-filter';
import { sqliteDatabase } from './database';

interface Projection {
  attributes?: string[] | { exclude?: string[] };
  include?: Array<Projection & { association: string }>;
}

describe('framework read selection', () => {
  let db: Database;
  let docs: Collection;
  let parser: AccessReadSelectionParser;
  let permissions: Map<string, AccessFilterReadGrant | null>;
  let resolver: ReturnType<typeof vi.fn>;
  const identity = (collection: Collection) => ({
    dataSourceKey: 'main',
    collectionKey: `${collection.name}-key`,
    collectionName: collection.name,
  });
  beforeEach(() => {
    db = sqliteDatabase();
    for (const name of ['documents', 'projects', 'children', 'links'])
      db.collection({
        name,
        timestamps: false,
        autoGenId: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
          { name: 'secret', type: 'string' },
        ],
      });
    docs = db.getCollection('documents');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    docs.setField('children', { type: 'hasMany', target: 'children', foreignKey: 'documentId' });
    docs.setField('child', { type: 'hasOne', target: 'children', foreignKey: 'documentId' });
    docs.setField('projects', {
      type: 'belongsToMany',
      target: 'projects',
      through: 'links',
      foreignKey: 'documentId',
      otherKey: 'projectId',
    });
    db.getCollection('projects').setField('documents', {
      type: 'hasMany',
      target: 'documents',
      foreignKey: 'projectId',
    });
    db.getCollection('children').setField('document', {
      type: 'belongsTo',
      target: 'documents',
      foreignKey: 'documentId',
    });
    permissions = new Map();
    resolver = vi.fn((collection: Collection, path: readonly string[]) =>
      permissions.has(path.join('.'))
        ? permissions.get(path.join('.'))!
        : {
            identity: identity(collection),
            fields: [...Object.keys(collection.model.rawAttributes), ...Object.keys(collection.model.associations)],
          },
    );
    parser = new AccessReadSelectionParser(db, resolver);
  });
  afterEach(async () => {
    await db.close();
  });
  const parse = (request = {}) => parser.parse(docs, request);
  const core = (request: Record<string, unknown>) => {
    const repository = db.getRepository('documents') as unknown as {
      buildQueryOptions(options: Record<string, unknown>): Projection;
    };
    const project = (collection: Collection, options: Projection): unknown => ({
      attributes: (Array.isArray(options.attributes)
        ? options.attributes
        : Object.keys(collection.model.rawAttributes).filter(
            (field) =>
              !options.attributes || Array.isArray(options.attributes) || !options.attributes.exclude?.includes(field),
          )
      ).sort(),
      expansions: (options.include ?? [])
        .map((child) => ({
          association: child.association,
          ...(project(
            db.modelCollection.get(collection.model.associations[child.association].target)!,
            child,
          ) as object),
        }))
        .sort((a, b) => a.association.localeCompare(b.association)),
    });
    return project(docs, repository.buildQueryOptions(structuredClone(request)));
  };
  const canonical = (selection: {
    attributes: string[];
    expansions: Array<{ association: string; attributes: string[]; expansions: unknown[] }>;
  }): unknown => ({
    attributes: [...selection.attributes].sort(),
    expansions: selection.expansions
      .map((child) => ({
        association: child.association,
        ...(canonical(child as typeof selection) as object),
      }))
      .sort((a, b) => a.association.localeCompare(b.association)),
  });
  it.each([
    {},
    { fields: ['name'] },
    { fields: ['name'], except: ['name'] },
    { except: ['secret'] },
    { fields: ['project.name'] },
    { appends: ['project.name'] },
    { appends: ['project.name', 'project'] },
    { appends: ['project', 'project.name'] },
    { appends: ['project.documents.name'] },
    { appends: ['project.documents.name', 'project.name'] },
    { appends: ['project.documents.name', 'project'], except: ['project.secret'] },
    { appends: ['project.name'], except: ['project.name'] },
    { appends: ['children.name', 'child.name', 'projects.name'] },
    { fields: [], appends: ['project.name'] },
  ])('matches the core supported field projection %#', (request) => {
    expect(canonical(parse(request))).toEqual(core(request));
  });
  it('uses only authorized physical defaults and never expands unrequested associations', () => {
    permissions.set('', { identity: identity(docs), fields: ['name', 'project'] });
    permissions.set('project', { identity: identity(db.getCollection('projects')), fields: ['name', 'documents'] });
    expect(parse({ appends: ['project'] })).toEqual({
      attributes: ['name'],
      expansions: [{ association: 'project', attributes: ['name'], expansions: [] }],
    });
  });
  it('merges duplicate paths without widening explicit field selections', () => {
    expect(parse({ fields: ['name', 'name'], appends: ['project.name', 'project.name'] })).toEqual({
      attributes: ['name'],
      expansions: [{ association: 'project', attributes: ['name'], expansions: [] }],
    });
  });
  it('does not widen empty field permissions or empty requests into unrestricted output', () => {
    expect(() => parse({ fields: [] })).toThrow();
    permissions.set('project', { identity: identity(db.getCollection('projects')), fields: [] });
    expect(() => parse({ fields: ['name'], appends: ['project'] })).toThrow(/authorized/);
    permissions.set('', { identity: identity(docs), fields: [] });
    expect(() => parse()).toThrow(/authorized/);
  });
  it('does not create an association solely to exclude one of its fields', () => {
    expect(parse({ fields: ['name'], except: ['project.secret'] })).toEqual({ attributes: ['name'], expansions: [] });
    expect(resolver.mock.calls.every(([, path]) => !path.length)).toBe(true);
  });
  it.each(['root', 'association', 'target', 'field'])('rejects missing %s authorization', (side) => {
    if (side === 'root') permissions.set('', null);
    if (side === 'association') permissions.set('', { identity: identity(docs), fields: ['name'] });
    if (side === 'target') permissions.set('project', null);
    if (side === 'field')
      permissions.set('project', { identity: identity(db.getCollection('projects')), fields: ['id'] });
    expect(() => parse({ fields: ['name'], appends: ['project.name'] })).toThrow(/authoriz/);
  });
  it.each([
    { fields: 'name' },
    { appends: 'project' },
    { except: 'secret' },
    { appends: ['project(limit=1)'] },
    { appends: ['project.*'] },
    { appends: ['project..name'] },
    { fields: ['unknown'] },
    { appends: ['name'] },
    { appends: ['project.unknown'] },
    { except: ['project'] },
    { except: ['unknown'] },
    { fields: Array(1) },
    { appends: ['project.documents.project.documents.name'] },
    { appends: Array(1001).fill('project') },
    { fields: ['x'.repeat(1025)] },
    { fields: ['name'], attributes: ['secret'] },
  ])('rejects unsupported or malformed selections %#', (request) => {
    expect(() => parse(request)).toThrow();
  });
  it('rejects input accessors and unusual array prototypes without invoking getters', () => {
    const getter = vi.fn(() => ['secret']);
    const request = Object.defineProperty({}, 'fields', { get: getter });
    expect(() => parse(request)).toThrow();
    const values = ['name'];
    Object.defineProperty(values, '0', { get: getter });
    expect(() => parse({ fields: values })).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => parse({ fields: Object.setPrototypeOf(['name'], {}) })).toThrow();
  });
  it('preserves non-enumerable selection descriptors and snapshots before permission callbacks', () => {
    const fields = ['name'];
    const appends = ['project.name'];
    resolver.mockImplementationOnce((collection: Collection) => {
      fields.push('secret');
      appends.length = 0;
      return { identity: identity(collection), fields: ['name', 'project'] };
    });
    const request = Object.defineProperty({ appends }, 'fields', { value: fields, enumerable: false });
    expect(parse(request)).toEqual({
      attributes: ['name'],
      expansions: [{ association: 'project', attributes: ['name'], expansions: [] }],
    });
  });
  it('keeps intermediate fields explicit when only nested relations are authorized', () => {
    permissions.set('project', { identity: identity(db.getCollection('projects')), fields: ['documents'] });
    expect(parse({ fields: [], appends: ['project.documents.name'] })).toEqual({
      attributes: [],
      expansions: [
        {
          association: 'project',
          attributes: [],
          expansions: [{ association: 'documents', attributes: ['name'], expansions: [] }],
        },
      ],
    });
  });
  it('excludes virtual getters from defaults and rejects their explicit selection', () => {
    docs.setField('display', { type: 'virtual' });
    expect(parse().attributes).not.toContain('display');
    expect(() => parse({ fields: ['display'] })).toThrow();
  });
  it('requires same-database registered targets and matching grant collection names', () => {
    permissions.set('project', { identity: identity(docs), fields: ['name'] });
    expect(() => parse({ appends: ['project.name'] })).toThrow();
    permissions.clear();
    db.modelCollection.delete(docs.model.associations.project.target);
    expect(() => parse({ appends: ['project.name'] })).toThrow();
  });
  it('limits total association nodes across sibling branches', () => {
    for (let index = 0; index < 21; index++)
      docs.setField(`project${index}`, { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    expect(() => parse({ appends: Array.from({ length: 21 }, (_, index) => `project${index}.name`) })).toThrow(/20/);
  });
});
