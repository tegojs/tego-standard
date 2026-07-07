import { i18n, tval as nTval, useApp } from '@tachybase/client';

import { NAMESPACE } from '../constants';

export { NAMESPACE };

/**
 * Renders or configures the lang client entry point.
 */
export function lang(key: string) {
  return i18n.t(key, { ns: NAMESPACE });
}

/**
 * Renders or configures the generate ntemplate client entry point.
 */
export function generateNTemplate(key: string) {
  return `{{t(${JSON.stringify(key)}, { ns: '${NAMESPACE}', nsMode: 'fallback' })}}`;
}

/**
 * Returns the use tenant translation hook state.
 */
export function useTenantTranslation() {
  const app = useApp();
  const translator = app?.i18n || i18n;
  const t = (key: string, props = {}) => translator.t(key, { ns: [NAMESPACE, 'client'], nsMode: 'fallback', ...props });

  return { t };
}

/**
 * Renders or configures the tval client entry point.
 */
export const tval = (key: string) => nTval(key, { ns: NAMESPACE });
