import { isDeepStrictEqual } from 'node:util';
import type { Database, Model, ModelStatic } from '@tego/server';

import type { AccessCondition, AccessConfig } from './types';
import { cloneDeep, invalid } from './write-support';

function modelSnapshot(model: ModelStatic<Model>) {
  const runtime = model as unknown as { _scope: unknown; _timestampAttributes: { deletedAt?: string } };
  const deletedAt = runtime._timestampAttributes.deletedAt;
  return cloneDeep({
    alias: model.name,
    table: model.getTableName(),
    primary: model.primaryKeyAttributes,
    attributes: Object.entries(model.rawAttributes).map(([name, attribute]) => [
      name,
      attribute.field,
      (attribute.type as { key?: string }).key,
      attribute.primaryKey,
    ]),
    scope: runtime._scope,
    paranoid: model.options.paranoid,
    deletedAt,
    deletedDefault: deletedAt ? model.rawAttributes[deletedAt]?.defaultValue : undefined,
  });
}

/** Snapshot only registered metadata used by these rules, not every collection in the application. */
export function accessMetadataGuard(
  db: Database,
  roots: Array<{ model: ModelStatic<Model>; config: AccessConfig }>,
  paths: Array<{ model: ModelStatic<Model>; path: readonly string[] }> = [],
) {
  const checks: Array<() => boolean> = [];
  const models = new Set<ModelStatic<Model>>();
  const captureModel = (model: ModelStatic<Model>) => {
    if (models.has(model)) return;
    const collection = db.modelCollection.get(model);
    if (!collection || collection.db !== db || model.sequelize !== db.sequelize)
      invalid('Access rule model is not registered in this database');
    const snapshot = modelSnapshot(model);
    models.add(model);
    checks.push(
      () =>
        db.getCollection(collection.name) === collection &&
        collection.model === model &&
        db.modelCollection.get(model) === collection &&
        isDeepStrictEqual(snapshot, modelSnapshot(model)),
    );
  };
  const captureAssociation = (model: ModelStatic<Model>, name: string) => {
    const association = model.associations[name] as (typeof model.associations)[string] & {
      foreignKey?: string;
      sourceKey?: string;
      targetKey?: string;
      otherKey?: string;
      scope?: unknown;
      through?: { model: ModelStatic<Model>; scope?: unknown; paranoid?: boolean };
    };
    if (!association || association.source !== model) invalid('Access rule association is unavailable');
    // The registry check below verifies this is the database's extended model, not a bare Sequelize model.
    const target = association.target as ModelStatic<Model>;
    const through = association.through?.model;
    captureModel(target);
    if (through) captureModel(through);
    const state = () => ({
      type: association.associationType,
      foreignKey: association.foreignKey,
      sourceKey: association.sourceKey,
      targetKey: association.targetKey,
      otherKey: association.otherKey,
      scope: association.scope,
      throughScope: association.through?.scope,
      throughParanoid: association.through?.paranoid,
    });
    const snapshot = cloneDeep(state());
    checks.push(
      () =>
        model.associations[name] === association &&
        association.source === model &&
        association.target === target &&
        association.through?.model === through &&
        isDeepStrictEqual(snapshot, state()),
    );
    return target;
  };
  const visit = (condition: AccessCondition, model: ModelStatic<Model>) => {
    if (condition.type === 'all' || condition.type === 'any') {
      condition.children.forEach((child) => visit(child, model));
    } else if (condition.type === 'not') {
      visit(condition.child, model);
    } else if (condition.type === 'exists') {
      for (const segment of condition.path.split('.')) model = captureAssociation(model, segment);
      visit(condition.condition, model);
    }
  };
  for (const { model, config } of roots) {
    captureModel(model);
    for (const rule of config.rules) {
      if (!rule.enabled) continue;
      visit(rule.subject, model);
      visit(rule.condition, model);
    }
  }
  for (const entry of paths) {
    let model = entry.model;
    captureModel(model);
    for (const segment of entry.path) model = captureAssociation(model, segment);
  }
  return () => {
    if (checks.some((check) => !check())) invalid('Expansion authorization metadata changed during query');
  };
}
