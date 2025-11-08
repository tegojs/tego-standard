import { Model } from '@tego/server';

import { EventSourceModel } from './EventSourceModel';

export class WebhookCategories extends Model {
  id: number;
  name: string;
  color: string;
  webhooks: EventSourceModel[];
}
