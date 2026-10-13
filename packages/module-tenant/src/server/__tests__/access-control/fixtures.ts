import type { AccessCondition, AccessConfig, CollectionMetadata } from '../../access-control/types';

export const participants: CollectionMetadata = {
  key: 'participant-table',
  table: ['access_participants'],
  fields: {
    id: { column: 'id', type: 'id' },
    documentId: { column: 'document_id', type: 'id' },
    businessTenant: { column: 'business_tenant', type: 'id' },
    canView: { column: 'can_view', type: 'boolean' },
  },
  associations: {},
};

export const documents: CollectionMetadata = {
  key: 'document-table',
  table: ['access_documents'],
  fields: {
    id: { column: 'id', type: 'id' },
    tenantId: { column: 'tenant_id', type: 'id' },
    amount: { column: 'amount', type: 'number' },
    name: { column: 'name', type: 'string' },
  },
  associations: {
    participants: { target: participants, sourceField: 'id', targetField: 'documentId' },
  },
};

export const ownerCondition = {
  type: 'compare',
  operator: 'eq',
  left: { type: 'field', path: 'tenantId' },
  right: { type: 'context', path: 'tenant.id' },
} satisfies AccessCondition;

export const participantCondition = {
  type: 'exists',
  path: 'participants',
  condition: {
    type: 'all',
    children: [
      {
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'businessTenant' },
        right: { type: 'context', path: 'tenant.id' },
      },
      {
        type: 'compare',
        operator: 'eq',
        left: { type: 'field', path: 'canView' },
        right: { type: 'literal', value: true },
      },
    ],
  },
} satisfies AccessCondition;

export function configFor(
  condition: AccessCondition,
  category: 'ownership' | 'visibility' = 'ownership',
): AccessConfig {
  return {
    schemaVersion: 1,
    revision: 1,
    ownership: { enabled: true },
    rules: [
      {
        id: 'test-rule',
        name: 'Test rule',
        enabled: true,
        category,
        subject: { type: 'constant', value: true },
        condition,
      },
    ],
  };
}

export const exampleConfig: AccessConfig = {
  ...configFor(ownerCondition),
  rules: [
    ...configFor(ownerCondition).rules,
    { ...configFor(participantCondition, 'visibility').rules[0], id: 'participants-can-read' },
  ],
};

export const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
