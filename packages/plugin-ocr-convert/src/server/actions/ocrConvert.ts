import actions, { Context, Next } from '@tego/server';

import { PluginOcrConvert } from '../plugin';

export async function recognize(ctx: Context, next: Next) {
  const plugin = ctx.tego.pm.get(PluginOcrConvert) as PluginOcrConvert;
  const { values } = ctx.action.params;
  const providerItem = await plugin.getDefault();
  if (!providerItem) {
    console.error(`[ocr-convert] no provider for action (${values.type}) provided`);
    return ctx.throw(500, 'no provider for action provided');
  }
  const ProviderType = plugin.providers.get(<string>providerItem.get('type'));
  if (!ProviderType) {
    console.error('[ocr-convert] invalid provider type:', providerItem.get('type'));
    return ctx.throw(500, 'invalid provider type');
  }
  const provider = new ProviderType(plugin, providerItem.get('options'));

  const result = await provider.recognize(ctx, values.image, values.type);
  ctx.body = result;
}
