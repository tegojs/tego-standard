import { findSchemaUtils, Icon, SchemaComponent } from '@tachybase/client';
import { observer, Schema } from '@tachybase/schema';

import { Layout } from 'antd';
import _ from 'lodash';

import { usePageRefresh } from '../../contexts/PageRefreshContext';
import { EditableGrid } from './EditableGrid';

interface EditorContentProps {
  schema: Schema;
}

export const EditorContent = observer<EditorContentProps>(({ schema }) => {
  const girdSchema = findSchemaUtils(schema, 'x-component', 'EditableGrid') || {};
  const { Content } = Layout;
  const { refreshKey } = usePageRefresh();
  const isEmpty = !girdSchema.properties;
  return (
    <Content key={refreshKey} style={{ padding: '5px', overflow: 'auto' }}>
      {isEmpty ? (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            paddingBottom: '10%',
          }}
        >
          <Icon type="add-fields" style={{ width: '200px', height: '100%' }} />
        </div>
      ) : (
        <SchemaComponent schema={schema} components={{ EditableGrid }} />
      )}
    </Content>
  );
});
