import { tval as nTval } from '@tachybase/client';

import { useTranslation } from 'react-i18next';

import { NAMESPACE } from '../constants';

export { NAMESPACE };

export function useTenantTranslation() {
  return useTranslation([NAMESPACE, 'core'], { nsMode: 'fallback' });
}

export const tval = (key: string) => nTval(key, { ns: NAMESPACE });
