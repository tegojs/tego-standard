import { useContext } from 'react';
import {
  DataBlockInitializer,
  Icon,
  SchemaInitializerItem,
  SchemaInitializerMenu,
  useAPIClient,
  useCollectionManager,
  useGlobalTheme,
  useSchemaInitializer,
  useSchemaInitializerItem,
  useTranslation,
} from '@tachybase/client';
import { SchemaOptionsContext } from '@tachybase/schema';

export const FormDesignBlockInitItem = () => {
  const { insert } = useSchemaInitializer();
  const { t } = useTranslation();
  const options = useContext(SchemaOptionsContext);
  const { theme } = useGlobalTheme();
  const itemConfig = useSchemaInitializerItem();
  const cm = useCollectionManager();
  const api = useAPIClient();
  return (
    <DataBlockInitializer
      {...itemConfig}
      componentType={'FormItem'}
      icon={<Icon type="FormOutlined" />}
      onCreateBlockSchema={async ({ item }) => {
        // const collection = cm.getCollection(item.name);
        // const titleField = collection.titleField;
        // const values = await FormDialog(
        //   t('Pick a data entry for viewing and editing'),
        //   () => {
        //     return (
        //       <APIClientProvider apiClient={api}>
        //         <SchemaComponentOptions scope={options.scope} components={{ ...options.components }}>
        //           <FormLayout layout={'vertical'}>
        //             <SchemaComponent
        //               schema={{
        //                 properties: {
        //                   id: {
        //                     title: tval('Please select'),
        //                     required: true,
        //                     'x-component': 'RemoteSelect',
        //                     'x-component-props': {
        //                       service: {
        //                         resource: item.name,
        //                       },
        //                       fieldNames: {
        //                         label: titleField,
        //                         value: 'id',
        //                       },
        //                     },
        //                     'x-decorator': 'FormItem',
        //                   },
        //                 },
        //               }}
        //             />
        //           </FormLayout>
        //         </SchemaComponentOptions>
        //       </APIClientProvider>
        //     );
        //   },
        //   theme,
        // ).open({
        //   initialValues: {},
        // });
        // const formSchema = createFormBlockSchema({
        //   dataSource: item.dataSource,
        //   collection: collection.name,
        //   action: 'get',
        //   filterByTk: values.id,
        //   actionInitializers: 'editForm:configureActions',
        // });
        // insert(formSchema);
      }}
    />
  );
};
