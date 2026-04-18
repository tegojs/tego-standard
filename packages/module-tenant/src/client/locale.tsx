import { tval as nTval, useApp } from '@tachybase/client';

export const NAMESPACE = 'tenant';

export function useTenantTranslation() {
  const { i18n } = useApp();
  const t = (key: string, props = {}) => i18n.t(key, { ns: NAMESPACE, ...props });
  return { t };
}

export const tval = (key: string) => nTval(key, { ns: NAMESPACE });
