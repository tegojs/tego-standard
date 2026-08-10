import type { Application, Collection } from '@tego/server';

import { getTargetCollection } from './tools';

type JSONValue = Record<string, unknown>;

type CopyPathStep = {
  fieldName: string;
  targetCollection: Collection;
  associationType: string;
  foreignKey?: string;
  foreignKeyOwner?: 'source' | 'target';
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
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isUniqueNonEmptyString(key: unknown, index: number, keys: unknown[]): key is string {
  return typeof key === 'string' && key.length > 0 && keys.indexOf(key) === index;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((path) => typeof path === 'string');
}

function getTargetKeys(
  collection: Collection,
  field: any,
): Pick<CopyPathStep, 'associationType' | 'foreignKey' | 'foreignKeyOwner' | 'targetKeys'> {
  const model = collection.model;
  const associationType = field.type;
  const foreignKey = field.foreignKey ?? field.options?.foreignKey;
  return {
    associationType,
    foreignKey,
    foreignKeyOwner:
      associationType === 'belongsTo'
        ? 'source'
        : associationType === 'hasMany' || associationType === 'hasOne'
          ? 'target'
          : undefined,
    targetKeys: [
      ...(model?.primaryKeyAttributes ?? []),
      model?.primaryKeyAttribute,
      collection.filterTargetKey,
      field.targetKey,
      field.options?.targetKey,
    ].filter(isUniqueNonEmptyString),
  };
}

function resolveCopyPath(collection: Collection, path: string, app?: Application): CopyPathStep[] {
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

    const targetCollection = getTargetCollection(fieldName, currentCollection, app);
    if (!targetCollection) {
      throw new CopyAssociationError(`Target collection for copy association path "${path}" was not found`);
    }

    steps.push({
      fieldName,
      targetCollection,
      ...getTargetKeys(targetCollection, field),
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
  const cleanedValue = { ...copiedValue };
  if (step.foreignKeyOwner === 'source' && step.foreignKey) {
    delete cleanedValue[step.foreignKey];
  }

  const cleanAssociationValue = (sourceItem: unknown, copiedItem: unknown): unknown => {
    if (sourceItem == null) {
      return copiedItem;
    }
    if (Array.isArray(sourceItem)) {
      const copiedItems = Array.isArray(copiedItem) ? copiedItem : [];
      return sourceItem.map((item, index) => cleanAssociationValue(item, copiedItems[index]));
    }
    if (typeof sourceItem !== 'object') {
      return sourceItem;
    }
    if (!isJSONValue(sourceItem)) {
      return copiedItem;
    }
    if (!isJSONValue(copiedItem)) {
      throw new CopyAssociationError(`Copy association path "${path}" must contain object values`);
    }

    const clonedItem = { ...copiedItem };
    for (const targetKey of step.targetKeys) {
      delete clonedItem[targetKey];
    }
    if (step.foreignKeyOwner === 'target' && step.foreignKey) {
      delete clonedItem[step.foreignKey];
    }
    if (stepIndex < steps.length - 1) {
      return omitTargetKeys(sourceItem, clonedItem, steps, stepIndex + 1, path);
    }
    return clonedItem;
  };

  return {
    ...cleanedValue,
    [step.fieldName]: cleanAssociationValue(sourceAssociationValue, copiedAssociationValue),
  };
}

export function cleanCopyAssociationData(
  sourceData: Record<string, unknown>,
  copiedData: Record<string, unknown>,
  collection: Collection,
  copyAssociationValues: unknown,
  app?: Application,
): Record<string, unknown> {
  if (copyAssociationValues == null) {
    return copiedData;
  }
  if (!isStringArray(copyAssociationValues)) {
    throw new CopyAssociationError('copyAssociationValues must be an array of association paths');
  }

  let cleanedData = copiedData;
  for (const path of new Set(copyAssociationValues)) {
    const steps = resolveCopyPath(collection, path, app);
    cleanedData = omitTargetKeys(sourceData, cleanedData, steps, 0, path) as Record<string, unknown>;
  }
  return cleanedData;
}
