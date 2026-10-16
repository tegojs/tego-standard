import type { Collection, Database } from '@tego/server';

import { captureReadPermissionPaths } from '../../access-control/read-permission-paths';
import { sqliteDatabase } from './database';

describe('finalized read permission paths', () => {
  let db: Database;
  let docs: Collection;
  let projects: Collection;
  let keys: Map<Collection, string>;
  beforeEach(() => {
    db = sqliteDatabase();
    for (const name of ['documents', 'projects'])
      db.collection({
        name,
        timestamps: false,
        fields: [
          { name: 'id', type: 'integer', primaryKey: true },
          { name: 'name', type: 'string' },
          { name: 'amount', type: 'integer' },
          { name: 'projectId', type: 'integer' },
        ],
      });
    docs = db.getCollection('documents');
    projects = db.getCollection('projects');
    docs.setField('project', { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
    projects.setField('documents', { type: 'hasMany', target: 'documents', foreignKey: 'projectId' });
    keys = new Map([
      [docs, 'documents-key'],
      [projects, 'projects-key'],
    ]);
  });
  afterEach(async () => db.close());
  const capture = (paths: string[]) =>
    captureReadPermissionPaths(db, docs, paths, (collection) => keys.get(collection));
  const fields = ['id', 'name', 'amount', 'project', 'documents'];

  it('unions terminal fields and relationship branches without granting intermediate physical fields', () => {
    const plan = capture(['project.name', 'project.amount', 'project.documents.name']);
    expect(plan.associations).toEqual(['project']);
    expect(plan.fieldsAt(['project'], fields)).toEqual(['name', 'amount', 'documents']);
    expect(plan.fieldsAt(['project', 'documents'], fields)).toEqual(['name']);
    expect(plan.fieldsAt(['missing'], fields)).toEqual([]);
    expect(plan.fieldsAt(['project', 'missing'], fields)).toEqual([]);
    expect(plan.fieldsAt(['project', 'documents', 'project'], fields)).toEqual([]);
  });
  it.each([
    ['project', 'project.name'],
    ['project.name', 'project'],
  ])('preserves bare association subtree permission: %j', (...paths) => {
    const plan = capture(paths);
    expect(plan.fieldsAt(['project'], fields)).toEqual(fields);
    expect(plan.fieldsAt(['project', 'documents'], fields)).toEqual(fields);
  });
  it('keeps one path snapshot independent of the caller array', () => {
    const paths = ['project.name'];
    const plan = capture(paths);
    paths[0] = 'project.amount';
    expect(plan.fieldsAt(['project'], fields)).toEqual(['name']);
  });
  it('does not change or mutate target field grants', () => {
    const plan = capture(['project.name']);
    const grant = Object.freeze(['id', 'amount']);
    expect(plan.fieldsAt(['project'], grant)).toEqual([]);
    expect(grant).toEqual(['id', 'amount']);
  });
  it.each([
    'name',
    'project.missing',
    'missing.name',
    'project.name.id',
    'project.',
    '.project',
    'project.*',
    'project.documents(limit=1)',
    'project.__proto__',
    'project.constructor',
    'project.$through.name',
    'project.documents.project.documents',
    'project.documents.project.documents.name',
    `project.${'x'.repeat(1024)}`,
  ])('rejects unsupported paths: %s', (path) => {
    expect(() => capture([path])).toThrow();
  });
  it('rejects missing or conflicting stable identities', () => {
    keys.delete(projects);
    expect(() => capture(['project.name'])).toThrow(/identity/);
    keys.set(projects, 'documents-key');
    expect(() => capture(['project.name'])).toThrow(/identity/);
  });
  it('rejects oversized association permission trees', () => {
    const paths: string[] = [];
    for (let index = 0; index <= 100; index++) {
      const name = `project_${index}`;
      docs.setField(name, { type: 'belongsTo', target: 'projects', foreignKey: 'projectId' });
      paths.push(`${name}.name`);
    }
    expect(() => capture(paths)).toThrow(/100 association paths/);
  });
  it('rejects virtual terminal fields', () => {
    projects.model.rawAttributes.name.type = { key: 'VIRTUAL' } as typeof projects.model.rawAttributes.name.type;
    expect(() => capture(['project.name'])).toThrow(/physical terminal fields/);
  });
  it('rejects a changed target identity after capture', () => {
    const plan = capture(['project.name']);
    keys.set(projects, 'replacement-key');
    expect(plan.assertCurrent).toThrow(/changed/);
  });
  it('rejects changed metadata of the referenced model', () => {
    const plan = capture(['project.name']);
    projects.model.rawAttributes.name.field = 'renamed';
    expect(plan.assertCurrent).toThrow(/changed/);
  });
  it('does not track unrelated association metadata', () => {
    docs.setField('other', { type: 'belongsTo', target: 'projects', foreignKey: 'otherId' });
    const plan = capture(['project.name']);
    const relation = docs.model.associations.other as typeof docs.model.associations.other & { targetKey: string };
    relation.targetKey = 'amount';
    expect(plan.assertCurrent).not.toThrow();
  });
});
