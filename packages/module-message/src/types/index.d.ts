import { MessageService } from '../server/MessageManager';

// Inject messageManager
declare module '@tego/server' {
  interface Application {
    messageManager: MessageService;
  }
}
