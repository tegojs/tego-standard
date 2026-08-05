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

function omitTargetKeys(
  sourceValue: unknown,
  copiedValue: unknown,
  steps: CopyPathStep[],
  stepIndex: number,
  path: string,
): unknown {
  if (sourceValue == null) {
    return copiedValue;
  }
  if (Array.isArray(sourceValue)) {
    const copiedItems = Array.isArray(copiedValue) ? copiedValue : [];
    return sourceValue.map((item, index) => omitTargetKeys(item, copiedItems[index], steps, stepIndex, path));
  }
  if (!isJSONValue(sourceValue) || !isJSONValue(copiedValue)) {
    throw new CopyAssociationError(`Copy association path "${path}" must contain object values`);
  }

  const step = steps[stepIndex];
  const sourceAssociationValue = sourceValue[step.fieldName];
  if (sourceAssociationValue === undefined) {
    return copiedValue;
  }
  const copiedAssociationValue = copiedValue[step.fieldName];

  const cleanAssociationValue = (sourceItem: unknown, copiedItem: unknown): unknown => {
    if (sourceItem == null) {
      return copiedItem;
    }
    if (Array.isArray(sourceItem)) {
      const copiedItems = Array.isArray(copiedItem) ? copiedItem : [];
      return sourceItem.map((item, index) => cleanAssociationValue(item, copiedItems[index]));
    }
    if (!isJSONValue(sourceItem)) {
      return sourceItem;
    }
    if (stepIndex < steps.length - 1) {
      return omitTargetKeys(sourceItem, copiedItem, steps, stepIndex + 1, path);
    }
    if (!isJSONValue(copiedItem)) {
      throw new CopyAssociationError(`Copy association path "${path}" must contain object values`);
    }

    const clonedItem = { ...copiedItem };
    for (const targetKey of step.targetKeys) {
      delete clonedItem[targetKey];
    }
    return clonedItem;
  };

  return {
    ...copiedValue,
    [step.fieldName]: cleanAssociationValue(sourceAssociationValue, copiedAssociationValue),
  };
}

export function cleanCopyAssociationData(
  sourceData: Record<string, unknown>,
  copiedData: Record<string, unknown>,
  collection: Collection,
  copyAssociationValues: unknown,
): Record<string, unknown> {
  if (copyAssociationValues == null) {
    return copiedData;
  }
  if (!Array.isArray(copyAssociationValues) || copyAssociationValues.some((path) => typeof path !== 'string')) {
    throw new CopyAssociationError('copyAssociationValues must be an array of association paths');
  }

  let cleanedData = copiedData;
  for (const path of new Set(copyAssociationValues)) {
    const steps = resolveCopyPath(collection, path);
    cleanedData = omitTargetKeys(sourceData, cleanedData, steps, 0, path) as Record<string, unknown>;
  }
  return cleanedData;
}
