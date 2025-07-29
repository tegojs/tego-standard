import { ISchema } from '@tachybase/schema';

import { Registry } from '@tego/client';

import TencentCloudOcr from './tencent-cloud';

const providerTypes: Registry<ISchema> = new Registry();

providerTypes.register('tencent-cloud', TencentCloudOcr);

export default providerTypes;
