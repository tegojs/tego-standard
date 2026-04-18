import { EventSourceTrigger } from '.';
import { NAMESPACE, tval } from '../locale';
import { createResourceTriggerOptions } from './resourceTriggerOptions';

export class CustomActionTrigger extends EventSourceTrigger {
  title = tval('Custom resource action');
  description = tval('for creating custom requests, try not to duplicate with other requests');
  options = createResourceTriggerOptions();
}
