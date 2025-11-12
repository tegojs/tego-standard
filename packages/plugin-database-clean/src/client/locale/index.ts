import { i18n, tval as nTval, useApp } from '@tachybase/client';

export const NAMESPACE = 'database-clean';

export function lang(key: string) {
  return i18n.t(key, { ns: NAMESPACE });
}

export function generateNTemplate(key: string) {
  return `{{t('${key}', { ns: '${NAMESPACE}', nsMode: 'fallback' })}}`;
}

export function useTranslation() {
  const { i18n: appI18n } = useApp();
  const t = (key: string, props = {}) => appI18n.t(key, { ns: [NAMESPACE, 'core'], nsMode: 'fallback', ...props });
  return { t };
}

export const tval = (key: string) => nTval(key, { ns: NAMESPACE });
