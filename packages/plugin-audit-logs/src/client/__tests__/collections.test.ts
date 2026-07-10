import { useAuditLogsCollection } from '../collections';

describe('audit logs client collection', () => {
  it('should expose tenantId for filtering audit logs by tenant', () => {
    const collection = useAuditLogsCollection();
    const tenantField = collection.fields.find((field) => field.name === 'tenantId');

    expect(tenantField).toMatchObject({
      name: 'tenantId',
      type: 'string',
      interface: 'input',
      uiSchema: {
        type: 'string',
        'x-component': 'Input',
      },
    });
    expect(tenantField?.uiSchema?.title).toContain('Tenant ID');
  });
});
