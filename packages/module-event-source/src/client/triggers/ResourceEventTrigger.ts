import { EventSourceTrigger } from '.';
import { NAMESPACE, tval } from '../locale';
import { createResourceTriggerOptions } from './resourceTriggerOptions';

export class ResourceEventTrigger extends EventSourceTrigger {
  constructor(title: string, description: string) {
    super();
    this.title = title;
    this.description = description;
  }
  options = createResourceTriggerOptions();
}
