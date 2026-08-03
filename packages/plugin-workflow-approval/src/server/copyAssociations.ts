import type { Collection } from '@tego/server';

type JSONValue = Record<string, unknown>;

type CopyPathStep = {
  fieldName: string;
  targetCollection: Collection;
  targetKeys: string[];
};

const ASSOCIATION_FIELD_TYPES = new Set(['belongsTo', 'belongsToMany', 'hasOne', 'hasMany']);

export class CopyAssociationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CopyAssociationError';
  }
}

function isJSONValue(value: unknown): value is JSONValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTargetKeys(collection: Collection, field: any): string[] {
  const model = collection.model;
  return [
    ...(model?.primaryKeyAttributes ?? []),
    model?.primaryKeyAttribute,
    collection.filterTargetKey,
    field.targetKey,
    field.options?.targetKey,
  ].filter(
    (key, index, keys): key is string => typeof key === 'string' && key.length > 0 && keys.indexOf(key) === index,
  );
}

function resolveCopyPath(collection: Collection, path: string): CopyPathStep[] {
  const fieldNames = path.split('.');
  if (fieldNames.some((fieldName) => !fieldName)) {
    throw new CopyAssociationError(`Invalid copy association path "${path}"`);
  }

  const steps: CopyPathStep[] = [];
  let currentCollection = collection;
  for (const fieldName of fieldNames) {
    const field = currentCollection.getField(fieldName) as any;
    if (!field || !ASSOCIATION_FIELD_TYPES.has(field.type) || !field.target) {
      throw new CopyAssociationError(`Copy association path "${path}" is not a valid association path`);
    }

    const targetCollection = (currentCollection as any).db?.getCollection(field.target) as Collection | undefined;
    if (!targetCollection) {
      throw new CopyAssociationError(`Target collection for copy association path "${path}" was not found`);
    }

    steps.push({
      fieldName,
      targetCollection,
      targetKeys: getTargetKeys(targetCollection, field),
    });
    currentCollection = targetCollection;
  }
  return steps;
}

function omitTargetKeys(value: unknown, steps: CopyPathStep[], stepIndex: number, path: string): unknown {
  if (value == null) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => omitTargetKeys(item, steps, stepIndex, path));
  }
  if (!isJSONValue(value)) {
    throw new CopyAssociationError(`Copy association path "${path}" must contain object values`);
  }

  const step = steps[stepIndex];
  const associationValue = value[step.fieldName];
  if (associationValue === undefined) {
    return value;
  }

  const cleanAssociationValue = (item: unknown): unknown => {
    if (item == null) {
      return item;
    }
    if (Array.isArray(item)) {
      return item.map(cleanAssociationValue);
    }
    if (!isJSONValue(item)) {
      throw new CopyAssociationError(`Copy association path "${path}" must contain object values`);
    }
    if (stepIndex < steps.length - 1) {
      return omitTargetKeys(item, steps, stepIndex + 1, path);
    }

    const clonedItem = { ...item };
    for (const targetKey of step.targetKeys) {
      delete clonedItem[targetKey];
    }
    return clonedItem;
  };

  return {
    ...value,
    [step.fieldName]: cleanAssociationValue(associationValue),
  };
}

export function omitCopyAssociationTargetKeys(
  data: Record<string, unknown>,
  collection: Collection,
  copyAssociationValues: unknown,
): Record<string, unknown> {
  if (copyAssociationValues == null) {
    return data;
  }
  if (!Array.isArray(copyAssociationValues) || copyAssociationValues.some((path) => typeof path !== 'string')) {
    throw new CopyAssociationError('copyAssociationValues must be an array of association paths');
  }

  let copiedData = data;
  for (const path of new Set(copyAssociationValues)) {
    const steps = resolveCopyPath(collection, path);
    copiedData = omitTargetKeys(copiedData, steps, 0, path) as Record<string, unknown>;
  }
  return copiedData;
}
