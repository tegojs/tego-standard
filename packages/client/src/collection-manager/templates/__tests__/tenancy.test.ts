import { ExpressionCollectionTemplate } from '../expression';
import { GeneralCollectionTemplate } from '../general';
import { SqlCollectionTemplate } from '../sql';
import { TreeCollectionTemplate } from '../tree';
import { ViewCollectionTemplate } from '../view';

vi.mock('@tego/client', () => ({
  getOptions: () => [],
}));

vi.mock('../components/PresetFields', () => ({
  PresetFields: () => null,
}));

vi.mock('../components/PreviewFields', () => ({
  PreviewFields: () => null,
}));

vi.mock('../components/PreviewTable', () => ({
  PreviewTable: () => null,
}));

vi.mock('../components/sql-collection', () => ({
  FieldsConfigure: () => null,
  PreviewTable: () => null,
  SQLInput: () => null,
  SQLRequestProvider: ({ children }) => children ?? null,
}));

vi.mock('../../../i18n', () => ({
  i18n: {
    t: (key: string) => key,
  },
}));

describe('collection template tenancy configuration', () => {
  it('should not expose tenancy configuration in base templates (injected by module-tenant plugin)', () => {
    for (const Template of [GeneralCollectionTemplate, TreeCollectionTemplate, ExpressionCollectionTemplate]) {
      const template = new Template();

      expect(template.configurableProperties.tenancy).toBeUndefined();
      expect(template.configurableProperties.legacyDataTenantIds).toBeUndefined();
    }
  });

  it('should not expose tenancy configuration for SQL and view collection templates', () => {
    expect(new SqlCollectionTemplate().configurableProperties.tenancy).toBeUndefined();
    expect(new SqlCollectionTemplate().configurableProperties.legacyDataTenantIds).toBeUndefined();
    expect(new ViewCollectionTemplate().configurableProperties.tenancy).toBeUndefined();
    expect(new ViewCollectionTemplate().configurableProperties.legacyDataTenantIds).toBeUndefined();
  });
});
