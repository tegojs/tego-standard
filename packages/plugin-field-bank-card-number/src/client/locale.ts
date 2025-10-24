import { useTranslation } from 'react-i18next';

export const NAMESPACE = 'field-bank-card-number';

export function useLang(key: string, options = {}) {
  const { t } = useTranslation(NAMESPACE, options);
  return t(key);
}

export function tval(key: string) {
  return `{{t('${key}', { ns: '${NAMESPACE}', nsMode: 'fallback' })}}`;
}
