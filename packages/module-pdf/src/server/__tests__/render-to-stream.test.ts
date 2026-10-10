import { createElement } from 'react';
import { readFileSync } from 'node:fs';

import { Document, Image, Page, renderToStream, Text } from '../index';

// Use the real Node entry used by the server build. / 使用服务端构建实际加载的 Node 入口。
// With the CI tsx loader, Yoga's CJS enum re-exports are missing from the ESM namespace.
// CI 的 tsx 加载器下，Yoga 的 CJS 枚举转导出在 ESM 命名空间中缺失。
vi.mock('@react-pdf/renderer', async () => {
  const { createRequire } = await import('node:module');
  return createRequire(import.meta.url)('@react-pdf/renderer');
});

it('renders distinct PDFs concurrently on first use while loading an image', async () => {
  const image = readFileSync('packages/module-file/src/server/__tests__/files/image.png');
  const results = await Promise.allSettled(
    [0, 1].map((index) =>
      renderToStream(
        createElement(
          Document,
          { title: `Concurrent PDF ${index}` },
          createElement(
            Page,
            null,
            createElement(Text, null, `Document ${index}`),
            createElement(Image, {
              src: () => new Promise<Buffer>((resolve) => setTimeout(() => resolve(image), index === 0 ? 100 : 0)),
            }),
          ),
        ),
      ).then(async (stream) => {
        const chunks: Buffer[] = [];
        for await (const chunk of stream) {
          chunks.push(Buffer.from(chunk));
        }
        return Buffer.concat(chunks).toString('latin1');
      }),
    ),
  );

  expect(results.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') {
      expect(result.value).toMatch(/^%PDF-/);
      expect(result.value).toContain(`(Concurrent PDF ${index})`);
    }
  });
});

it('preserves a first-render error and still renders the waiting document', async () => {
  vi.resetModules();
  const { renderToStream: render } = await import('../render-to-stream');
  const results = await Promise.allSettled([
    render(
      createElement(
        Document,
        null,
        createElement(Page, null, createElement(Text, { style: { fontFamily: 'UnregisteredTestFont' } }, 'Invalid')),
      ),
    ),
    render(createElement(Document, null, createElement(Page, null, createElement(Text, null, 'Valid')))),
  ]);
  expect(results[0].status).toBe('rejected');
  if (results[0].status === 'rejected') {
    expect(results[0].reason.message).toContain('UnregisteredTestFont');
  }
  expect(results[1].status).toBe('fulfilled');
  if (results[1].status === 'fulfilled') {
    results[1].value.resume();
  }
});
