import { i18n, tval as nTval, useTranslation as useT } from '@tachybase/client';

import { NAMESPACE } from './constants';

export function useTranslation() {
  return useT([NAMESPACE, 'core'], { nsMode: 'fallback' });
}
export function lang(key: string, options = {}) {
  return i18n.t(key, {
    ...options,
    ns: NAMESPACE,
  });
}

export const tval = (
  key: string,
  options = {
    ns: NAMESPACE,
  },
) => nTval(key, options);
