import { SchemaComponent } from '@tachybase/client';

export const CouldAssociationComponent = (props) => {
  console.log('🚀 ~ CouldAssociationComponent ~ props:', props);
  const schema = {
    partyA: {
      'x-decorator': null,
      'x-decorator-props': {
        labelStyle: {
          display: 'none',
        },
      },
      'x-component': 'CollectionField',
      'x-component-props': {
        fieldNames: {
          value: 'id',
          label: 'name',
        },
        ellipsis: true,
        size: 'small',
      },
      'x-read-pretty': true,
      _isJSONSchemaObject: true,
      version: '2.0',
      'x-collection-field': 'contracts.partyA',
      'x-uid': 'iksz10yd4t9',
      'x-async': false,
      'x-index': 1,
    },
  };
  // return <SchemaComponent schema={ schema} >{props.children}</SchemaComponent>
  return <div>12345678</div>;
};
