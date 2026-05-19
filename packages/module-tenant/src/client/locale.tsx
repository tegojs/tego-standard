import { tval as nTval, useApp } from '@tachybase/client';

import { NAMESPACE } from '../constants';

export { NAMESPACE };

export function useTenantTranslation() {
  const { i18n } = useApp();
  const t = (key: string, props = {}) => i18n.t(key, { ns: [NAMESPACE, 'core'], nsMode: 'fallback', ...props });

  return { t };
}

export const tval = (key: string) => nTval(key, { ns: NAMESPACE });
