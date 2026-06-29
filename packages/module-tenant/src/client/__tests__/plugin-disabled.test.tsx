/**
 * Regression tests: module-tenant NOT loaded.
 *
 * When PluginTenantClient is absent from the application,
 * tenant-specific UI capabilities must NOT appear.
 */
import React from 'react';
import {
  Application,
  CollectionTemplate,
  CurrentNavigationMenuProvider,
  useCurrentNavigationMenu,
} from '@tachybase/client';
import { render, waitFor } from '@tachybase/test/client';

import { describe, expect, it } from 'vitest';

import CurrentTenantProvider, { CurrentTenantContext } from '../CurrentTenantProvider';
import TenantMenuProvider from '../TenantMenuProvider';

/** Stub templates used to verify injection does NOT occur. */
class StubGeneralTemplate extends CollectionTemplate {
  name = 'general';
  configurableProperties = {} as any;
}
class StubSqlTemplate extends CollectionTemplate {
  name = 'sql';
  configurableProperties = {} as any;
}

function createAppWithoutTenant() {
  return new Application({
    plugins: [],
    dataSourceManager: {
      collectionTemplates: [StubGeneralTemplate, StubSqlTemplate],
    },
  });
}

describe('module-tenant not loaded (client)', () => {
  it('should not register tenant management entry in system settings', async () => {
    const app = createAppWithoutTenant();
    await app.load();

    expect(app.systemSettingsManager.get('id-auth.tenants')).toBeFalsy();
  });

  it('should not inject tenancy fields into collection templates', async () => {
    const app = createAppWithoutTenant();
    await app.load();

    const ctm = app.dataSourceManager.collectionTemplateManager;
    const general = ctm.getCollectionTemplate('general');
    expect(general.configurableProperties.tenancy).toBeUndefined();
    expect(general.configurableProperties.legacyDataTenantIds).toBeUndefined();
  });

  it('should not register LegacyDataTenantSelect as a component', async () => {
    const app = createAppWithoutTenant();
    await app.load();

    // When the tenant plugin is not loaded, LegacyDataTenantSelect should not
    // be in the app component registry.
    const components = (app as any).components || {};
    expect(components.LegacyDataTenantSelect).toBeUndefined();
  });

  it('should not wrap the application with CurrentTenantProvider', async () => {
    const app = createAppWithoutTenant();
    await app.load();

    const providers: Array<[any, any]> = app.providers || [];
    const hasTenantProvider = providers.some(([Comp]) => Comp === CurrentTenantProvider);
    expect(hasTenantProvider).toBe(false);
  });

  it('should not wrap the application with TenantMenuProvider', async () => {
    const app = createAppWithoutTenant();
    await app.load();

    const providers: Array<[any, any]> = app.providers || [];
    const hasMenuProvider = providers.some(([Comp]) => Comp === TenantMenuProvider);
    expect(hasMenuProvider).toBe(false);
  });

  it('should not render tenant switcher in the navigation area without tenant context', async () => {
    // When TenantMenuProvider is not loaded and CurrentTenantContext is empty,
    // the navigation should NOT contain a tenant switcher.
    const NavigationItems = () => {
      const { getItems } = useCurrentNavigationMenu();
      return <>{getItems().map((item: any) => React.cloneElement(item, { key: item.key }))}</>;
    };

    const { container } = render(
      <CurrentTenantContext.Provider value={{ data: undefined }}>
        <CurrentNavigationMenuProvider>
          <NavigationItems />
        </CurrentNavigationMenuProvider>
      </CurrentTenantContext.Provider>,
    );

    await waitFor(() => {
      expect(container.querySelector('.tenant-nav-switcher')).not.toBeInTheDocument();
    });
  });

  it('should not render tenant switcher when tenant context returns empty data', async () => {
    const NavigationItems = () => {
      const { getItems } = useCurrentNavigationMenu();
      return <>{getItems().map((item: any) => React.cloneElement(item, { key: item.key }))}</>;
    };

    const { container } = render(
      <CurrentTenantContext.Provider value={{ data: { data: [] } }}>
        <CurrentNavigationMenuProvider>
          <NavigationItems />
        </CurrentNavigationMenuProvider>
      </CurrentTenantContext.Provider>,
    );

    await waitFor(() => {
      expect(container.querySelector('.tenant-nav-switcher')).not.toBeInTheDocument();
    });
  });
});
