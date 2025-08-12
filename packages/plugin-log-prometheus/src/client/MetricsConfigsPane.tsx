import { ExtendCollectionsProvider, SchemaComponent } from '@tachybase/client';

import { Card } from 'antd';

import { metricsConfigsCollection } from './collections/metricsConfigsCollection';
import { schemaMetricsConfigs } from './schemas/schemaMetricsConfigs';

export const MetricsConfigsPane = () => {
  return (
    <Card bordered={false}>
      <ExtendCollectionsProvider collections={[metricsConfigsCollection]}>
        <SchemaComponent schema={schemaMetricsConfigs} />
      </ExtendCollectionsProvider>
    </Card>
  );
};
