import { Migration } from '@tego/server';

export default class InitSystemStatusesMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.4.0';

  async up() {
    const { db } = this.context;

    const systemStatuses = [
      {
        key: 'active',
        title: '{{t("Active")}}',
        color: 'green',
        allowLogin: true,
        loginErrorMessage: null,
        isSystemDefined: true,
        packageName: '@tachybase/module-user',
        description: '{{t("Normal active user")}}',
        sort: 1,
        config: {},
      },
      {
        key: 'pending',
        title: '{{t("Pending")}}',
        color: 'orange',
        allowLogin: false,
        loginErrorMessage: '{{t("Your account is under review, please wait for administrator approval")}}',
        isSystemDefined: true,
        packageName: '@tachybase/module-user',
        description: '{{t("User waiting for approval")}}',
        sort: 2,
        config: {},
      },
      {
        key: 'disabled',
        title: '{{t("Disabled")}}',
        color: 'gray',
        allowLogin: false,
        loginErrorMessage:
          '{{t("Your account has been disabled, please contact administrator if you have any questions")}}',
        isSystemDefined: true,
        packageName: '@tachybase/module-user',
        description: '{{t("Manually disabled by administrator")}}',
        sort: 3,
        config: {},
      },
    ];

    const statusRepo = db.getRepository('userStatuses');

    if (!statusRepo) {
      this.app.logger.warn('userStatuses repository not found, skipping migration');
      return;
    }

    for (const status of systemStatuses) {
      try {
        const existing = await statusRepo.findOne({
          filter: { key: status.key },
        });

        if (!existing) {
          await statusRepo.create({
            values: status,
          });
          this.app.logger.info(`Created system status: ${status.key}`);
        } else {
          // 更新现有状态以确保字段完整
          await statusRepo.update({
            filterByTk: status.key,
            values: {
              ...status,
            },
          });
          this.app.logger.info(`Updated system status: ${status.key}`);
        }
      } catch (error) {
        this.app.logger.error(`Failed to create/update system status ${status.key}:`, error);
      }
    }

    this.app.logger.info('System statuses initialization completed successfully');
  }
}
