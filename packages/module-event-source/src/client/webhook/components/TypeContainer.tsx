import React from 'react';
import { SchemaComponent } from '@tachybase/client';

export const TypeContainer = (props) => {
  const { options } = props;
  if (!options || typeof options !== 'object') {
    return null;
  }
  return (
    <div style={{ width: '100%', minWidth: 0 }}>
      <SchemaComponent schema={{ type: 'object', properties: options }} />
    </div>
  );
};
