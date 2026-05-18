import { ExpressionCollectionTemplate } from '../expression';
import { GeneralCollectionTemplate } from '../general';
import { SqlCollectionTemplate } from '../sql';
import { TreeCollectionTemplate } from '../tree';
import { ViewCollectionTemplate } from '../view';

describe('collection template tenancy configuration', () => {
  it('should expose tenancy configuration for standard data collection templates', () => {
    for (const Template of [GeneralCollectionTemplate, TreeCollectionTemplate, ExpressionCollectionTemplate]) {
      const template = new Template();

      expect(template.configurableProperties.tenancy).toMatchObject({
        type: 'string',
        'x-component': 'Select',
      });
      expect(template.configurableProperties.tenancy.enum).toEqual([
        { label: '{{t("Shared collection")}}', value: 'shared' },
        { label: '{{t("Tenant scoped")}}', value: 'tenantScoped' },
        { label: '{{t("Tenant inherited")}}', value: 'tenantInherited' },
      ]);
    }
  });

  it('should not expose tenancy configuration for SQL and view collection templates', () => {
    expect(new SqlCollectionTemplate().configurableProperties.tenancy).toBeUndefined();
    expect(new ViewCollectionTemplate().configurableProperties.tenancy).toBeUndefined();
  });
});
