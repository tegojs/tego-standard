import { i18n, tval as nTval, useApp } from '@tachybase/client';

import { NAMESPACE } from '../constants';

export { NAMESPACE };

export function lang(key: string) {
  return i18n.t(key, { ns: NAMESPACE });
}

export function generateNTemplate(key: string) {
  return `{{t('${key}', { ns: '${NAMESPACE}', nsMode: 'fallback' })}}`;
}

export function useTenantTranslation() {
  const { i18n: appI18n } = useApp();
  const t = (key: string, props = {}) => appI18n.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback', ...props });

  return { t };
}

export const tval = (key: string) => nTval(key, { ns: NAMESPACE });
