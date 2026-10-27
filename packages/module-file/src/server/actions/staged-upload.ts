import { createWriteStream, promises as fs, type WriteStream } from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { koaMulter as multer, type Context } from '@tego/server';

import { DEFAULT_MAX_FILE_SIZE, FILE_FIELD_NAME, LIMIT_FILES } from '../constants';
import { createUploadFileFilter } from './upload-rules';

export interface StagedAttachmentOptions {
  /** Existing, server-owned temporary parent directory. Never supplied by request parameters. */
  directory: string;
  maxFileSize: number;
  rules?: Record<string, unknown>;
}

export interface StagedAttachmentUpload {
  readonly path: string;
  readonly originalname: string;
  readonly mimetype: string;
  readonly size: number;
}

/** Disk staging only. The authenticated caller still owns G checks and final storage/transaction coordination. */
export async function withStagedAttachmentUpload<T>(
  ctx: Context,
  options: StagedAttachmentOptions,
  execute: (file: StagedAttachmentUpload) => Promise<T>,
): Promise<T> {
  const { directory, maxFileSize } = options;
  // koaMulter attaches the same file to context and Koa request; Request lacks that optional extension.
  const request = ctx.request as Context['request'] & { file?: Context['file'] };
  if (
    typeof directory !== 'string' ||
    !path.isAbsolute(directory) ||
    !Number.isSafeInteger(maxFileSize) ||
    maxFileSize <= 0 ||
    maxFileSize > DEFAULT_MAX_FILE_SIZE ||
    typeof execute !== 'function'
  )
    throw new TypeError('Upload staging requires an absolute directory, bounded server limit and consumer');
  if (ctx.file !== undefined || request.file !== undefined || ctx.req['file'] !== undefined)
    ctx.throw(400, 'Upload has already been parsed');
  const rules = structuredClone(options.rules === undefined ? {} : options.rules);
  const fileFilter = createUploadFileFilter(() => rules);
  const parent = await fs.realpath(directory);
  const temporary = await fs.mkdtemp(path.join(parent, 'tego-file-upload-'));
  const uploadPath = path.join(temporary, 'upload');
  const outputs: Array<{ input: Readable; stream: WriteStream; closed: Promise<void> }> = [];
  const abortUpload = (error?: Error) => {
    const failure = error ?? new Error('Upload request was aborted');
    // Multer waits for pending writes on request errors. End the corresponding input
    // so its existing error handler can settle the parse before we await output close.
    for (const { input } of outputs) if (!input.destroyed && !input.readableEnded) input.destroy(failure);
  };
  ctx.req.on('aborted', abortUpload);
  ctx.req.on('error', abortUpload);
  const closeOutputs = async () => {
    for (const { stream } of outputs) if (!stream.closed) stream.destroy();
    await Promise.all(outputs.map(({ closed }) => closed));
  };
  let parsed: Context['file'];
  const cleanup = async () => {
    ctx.req.off('aborted', abortUpload);
    ctx.req.off('error', abortUpload);
    if (ctx.file === parsed) delete ctx.file;
    if (request.file === parsed) delete request.file;
    // A failed multipart parse can leave its partial file on the raw request only.
    delete ctx.req['file'];
    await closeOutputs();
    await fs.rm(temporary, { recursive: true, force: true });
  };
  let result: T;
  try {
    if (ctx.req.aborted || ctx.req.destroyed) throw new Error('Upload request was aborted');
    const upload = multer({
      fileFilter,
      limits: { fileSize: maxFileSize, files: LIMIT_FILES },
      storage: {
        _handleFile(_request, file, cb) {
          const output = createWriteStream(uploadPath, { flags: 'wx', mode: 0o600 });
          const closed = new Promise<void>((resolve) => output.once('close', resolve));
          outputs.push({ input: file.stream, stream: output, closed });
          output.once('error', cb);
          output.once('finish', () =>
            cb(null, {
              destination: temporary,
              filename: 'upload',
              path: uploadPath,
              size: output.bytesWritten,
            }),
          );
          file.stream.pipe(output);
        },
        async _removeFile(_request, _file, cb) {
          try {
            await closeOutputs();
            await fs.rm(uploadPath, { force: true });
          } catch (error) {
            cb(error);
            return;
          }
          cb(null);
        },
      },
    }).single(FILE_FIELD_NAME);
    try {
      await upload(ctx, async () => {});
    } catch (error) {
      if (error.name === 'MulterError') ctx.throw(400, error);
      throw error;
    }
    parsed = ctx.file;
    if (!parsed) ctx.throw(400, 'file validation failed');
    result = await execute(
      Object.freeze({
        path: uploadPath,
        originalname: Buffer.from(parsed.originalname, 'latin1').toString('utf8'),
        mimetype: parsed.mimetype,
        size: parsed.size,
      }),
    );
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      ctx.logger.error('Failed to remove staged attachment', { error: cleanupError, directory: temporary });
    }
    throw error;
  }
  await cleanup();
  return result;
}
