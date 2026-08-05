import type { Form } from '@tachybase/schema';

const COPY_ASSOCIATION_MODES = new Set(['Nester', 'SubTable', 'PopoverNester']);
const ASSOCIATION_FIELD_TYPES = new Set(['belongsTo', 'belongsToMany', 'hasOne', 'hasMany']);

type CollectionFieldResolver = {
  getField?: (name: string) => { type?: string; target?: string } | undefined;
};

function getAssociationPath(field: Form['fields'][string]) {
  return field.path.segments.filter((segment) => !/^\d+$/.test(String(segment))).join('.');
}

function isAssociationPath(collection: CollectionFieldResolver | undefined, path: string) {
  const field = collection?.getField?.(path);
  return Boolean(field?.target && ASSOCIATION_FIELD_TYPES.has(field.type));
}

export function getCopyAssociationValues(
  form: Form,
  collection: CollectionFieldResolver | undefined,
  configuredPaths: string[] = [],
) {
  const paths = new Set(configuredPaths.filter((path) => isAssociationPath(collection, path)));

  Object.values(form.fields).forEach((field) => {
    if (field && COPY_ASSOCIATION_MODES.has(field.componentProps?.mode)) {
      const path = getAssociationPath(field);
      if (isAssociationPath(collection, path)) {
        paths.add(path);
      }
    }
  });

  return [...paths];
}
