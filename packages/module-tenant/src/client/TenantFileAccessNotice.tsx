import React from 'react';

import { Alert } from 'antd';

import { useTenantTranslation } from './locale';

/** Informational only; metadata rules do not authorize or protect public content URLs. */
export function TenantFileAccessNotice({ template }: { template?: string }) {
  const { t } = useTenantTranslation();
  if (template !== 'file') return null;
  return (
    <Alert
      type="warning"
      showIcon
      message={t(
        'These rules restrict attachment records, not public file links. File-content isolation also requires controlled downloads.',
      )}
    />
  );
}
