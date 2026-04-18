import { Application } from '@tachybase/client';

import PluginTenantClient from '..';
import CurrentTenantProvider from '../CurrentTenantProvider';
import TenantMenuProvider from '../TenantMenuProvider';

describe('PluginTenantClient', () => {
  it('should register tenant providers on load', async () => {
    const app = new Application({
      plugins: [[PluginTenantClient, { name: 'tenant' }]],
    });

    await app.load();

    expect(app.providers).toEqual(
      expect.arrayContaining([
        [CurrentTenantProvider, undefined],
        [TenantMenuProvider, undefined],
      ]),
    );
  });
});
