import type { ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';

import {
  withAuthorizedLocalAttachmentRead,
  type AuthorizedAttachmentReadEntry,
} from '../storages/authorized-local-read';

/** Explicit Node HTTP executor only. Framework adapters must delegate response ownership and await it.
 * No production route or public URL is registered. Already-sent bytes cannot be revoked.
 */
export async function sendAuthorizedLocalAttachment(
  entry: AuthorizedAttachmentReadEntry,
  render: (values: Record<string, unknown>) => unknown,
  response: ServerResponse,
): Promise<void> {
  const request = response.req;
  if (request.method !== 'GET' || request.headers.range !== undefined)
    throw new TypeError('Attachment content sending supports only complete GET requests');
  if (request.aborted || response.destroyed || response.headersSent || response.writableEnded)
    throw new TypeError('Attachment response is no longer available');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const closed = () => {
    if (!response.writableFinished) abort();
  };
  request.on('aborted', abort);
  response.on('close', closed);
  response.on('error', abort);
  try {
    await withAuthorizedLocalAttachmentRead(entry, render, async (handle) => {
      controller.signal.throwIfAborted();
      if (response.destroyed || response.headersSent || response.writableEnded)
        throw new TypeError('Attachment response changed before content release');
      response.statusCode = 200;
      for (const header of ['Content-Length', 'Content-Encoding', 'Content-Range', 'ETag', 'Last-Modified'])
        response.removeHeader(header);
      response.setHeader('Content-Type', 'application/octet-stream');
      response.setHeader('Content-Disposition', 'attachment');
      response.setHeader('Cache-Control', 'private, no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Accept-Ranges', 'none');
      // Keep the same authorized descriptor open until pipeline settles, including abort and backpressure.
      await pipeline(handle.createReadStream({ autoClose: false }), response, { signal: controller.signal });
    });
  } finally {
    request.off('aborted', abort);
    response.off('close', closed);
    response.off('error', abort);
  }
}
