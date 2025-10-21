import { Migration } from '@tego/server';

export default class AddUserStatusFieldsMigration extends Migration {
  on = 'afterLoad';
  appVersion = '<1.4.0';

  async up() {
    const { db } = this.context;
    const userCollection = db.getCollection('users');

    if (!userCollection) {
      this.app.logger.warn('Users collection not found, skipping migration');
      return;
    }

    // 添加 status 字段
    if (!userCollection.hasField('status')) {
      userCollection.setField('status', {
        type: 'string',
        defaultValue: 'active',
      });
      this.app.logger.info('Added status field to users table');
    }

    // 添加 statusExpireAt 字段
    if (!userCollection.hasField('statusExpireAt')) {
      userCollection.setField('statusExpireAt', {
        type: 'date',
        allowNull: true,
      });
      this.app.logger.info('Added statusExpireAt field to users table');
    }

    // 添加 previousStatus 字段
    if (!userCollection.hasField('previousStatus')) {
      userCollection.setField('previousStatus', {
        type: 'string',
        allowNull: true,
      });
      this.app.logger.info('Added previousStatus field to users table');
    }

    // 添加 statusReason 字段
    if (!userCollection.hasField('statusReason')) {
      userCollection.setField('statusReason', {
        type: 'text',
        allowNull: true,
      });
      this.app.logger.info('Added statusReason field to users table');
    }

    // 同步数据库结构
    await db.sync();

    // 为现有用户设置默认状态
    try {
      const hasData = await db.sequelize.query(
        `SELECT COUNT(*) as count FROM users WHERE status IS NULL OR status = ''`,
        { type: 'SELECT' },
      );

      const count = (hasData[0] as any)?.count || 0;
      if (count > 0) {
        await db.sequelize.query(`UPDATE users SET status = 'active' WHERE status IS NULL OR status = ''`);
        this.app.logger.info(`Set default status 'active' for ${count} existing users`);
      }
    } catch (error) {
      this.app.logger.error('Failed to set default status for existing users:', error);
    }

    this.app.logger.info('User status fields migration completed successfully');
  }
}
