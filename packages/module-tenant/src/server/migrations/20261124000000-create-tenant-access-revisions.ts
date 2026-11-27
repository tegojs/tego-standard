import { Migration } from '@tego/server';

/** Installs the immutable audit table required by administrator-managed rule revisions. */
export default class CreateTenantAccessRevisions extends Migration {
  on = 'afterLoad';
  appVersion = '<1.6.64';

  async up() {
    const history = this.db.getCollection('tenantAccessRevisions');
    if (!history) throw new Error('Tenant access revision collection is not registered');
    await history.model.sync();
  }

  // Audit history is intentionally retained on rollback.
  async down() {}
}
