export const NAMESPACE = 'field-bank-card-number';

export function tval(key: string) {
  return `{{t('${key}', { ns: '${NAMESPACE}', nsMode: 'fallback' })}}`;
}
