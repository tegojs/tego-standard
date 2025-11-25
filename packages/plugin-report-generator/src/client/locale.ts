import { i18n } from '@tachybase/client';

export const NAMESPACE = '@tachybase/plugin-report-generator';

export function useTranslation() {
  const t = (key: string, options = {}) => i18n.t(key, { ns: NAMESPACE, ...options });
  return { t };
}

export function lang(key: string, options = {}) {
  return i18n.t(key, {
    ...options,
    ns: NAMESPACE,
  });
}
