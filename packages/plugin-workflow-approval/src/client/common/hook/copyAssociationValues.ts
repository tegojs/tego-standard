import type { Form } from '@tachybase/schema';

const COPY_ASSOCIATION_MODES = new Set(['Nester', 'SubTable', 'PopoverNester']);

function getAssociationPath(field: Form['fields'][string]) {
  return field.path.segments.filter((segment) => !/^\d+$/.test(String(segment))).join('.');
}

export function getCopyAssociationValues(form: Form, configuredPaths: string[] = []) {
  const paths = new Set(configuredPaths);

  Object.values(form.fields).forEach((field) => {
    if (field && COPY_ASSOCIATION_MODES.has(field.componentProps?.mode)) {
      paths.add(getAssociationPath(field));
    }
  });

  return [...paths];
}
