import { actions } from '@tego/server';

import type PluginFileManager from '../server';
import { createAttachmentActionEntry } from './attachment-entry';
import { createMiddleware, destroyMiddleware } from './attachments';

export default function ({ app, options }: PluginFileManager) {
  const resolve = options.attachmentResolver;
  const entry = resolve === undefined ? undefined : createAttachmentActionEntry(resolve);
  if (entry) {
    app.resourcer.use(entry.select, {
      tag: 'attachmentActionSelection',
      before: ['createMiddleware', 'fileUploadHandling'],
    });
    app.resourcer.use(entry.execute, {
      tag: 'attachmentActionExecution',
      after: ['acl', 'attachmentActionSelection'],
    });
  }
  app.resourcer.use(entry ? entry.storage(createMiddleware) : createMiddleware, {
    tag: 'createMiddleware',
    after: 'auth',
  });
  app.resourcer.registerActionHandler('upload', actions.create);

  app.resourcer.use(entry ? entry.storage(destroyMiddleware) : destroyMiddleware, { tag: 'fileUploadHandling' });
}
