import { i18n, tval as nTval, useApp } from '@tachybase/client';

import { NAMESPACE } from '../constants';

export { NAMESPACE };

export function lang(key: string) {
  return i18n.t(key, { ns: NAMESPACE });
}

export function generateNTemplate(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: '${NAMESPACE}', nsMode: 'fallback' })}}`;
}

export function useTenantTranslation() {
  const app = useApp();
  const translator = app?.i18n || i18n;
  const t = (key: string, props = {}) => translator.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback', ...props });

  return { t };
}

export const tval = (key: string) => nTval(key, { ns: NAMESPACE });
