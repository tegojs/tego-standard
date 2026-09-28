import { EventSourceTrigger } from '.';
import { tval } from '../locale';

export class HttpEndpointTrigger extends EventSourceTrigger {
  title = tval('HTTP endpoint');
  description = tval('Expose an HTTP endpoint that runs code and triggers the selected workflow');
  options = {};
}
