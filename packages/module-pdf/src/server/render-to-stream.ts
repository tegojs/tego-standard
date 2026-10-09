import { renderToStream as rendererRenderToStream } from '@react-pdf/renderer';

let initialized = false;
let firstRender: ReturnType<typeof rendererRenderToStream> | undefined;

export async function renderToStream(
  ...args: Parameters<typeof rendererRenderToStream>
): ReturnType<typeof rendererRenderToStream> {
  if (initialized) {
    return rendererRenderToStream(...args);
  }
  if (firstRender) {
    // Retry with this document if the first render failed. / 首次失败后仍尝试当前文档。
    await firstRender.catch(() => undefined);
    return renderToStream(...args);
  }

  // Yoga 3.x must finish its first layout before another render starts.
  // Yoga 3.x 首次布局完成前不能并发初始化，后续渲染仍可并发。
  firstRender = rendererRenderToStream(...args);
  try {
    const stream = await firstRender;
    initialized = true;
    return stream;
  } finally {
    firstRender = undefined;
  }
}
