import { Plugin, tval } from '@tachybase/client';
import ACLPlugin from '@tachybase/module-acl/client';

import { RoleUsersManager } from './RoleUsersManager';
import { ChangePassword } from './UserChangePassword';
import { UserProfile } from './UserProfile';
import { UsersManagement } from './UsersManagement';
import { UserStatusHistories } from './UserStatusHistories';
import { UserStatusManagement } from './UserStatusManagement';

class PluginUsersClient extends Plugin {
  async load() {
    this.app.systemSettingsManager.add('id-auth.users', {
      title: tval('Users'),
      icon: 'UserOutlined',
      Component: UsersManagement,
      aclSnippet: 'pm.users',
    });

    this.app.systemSettingsManager.add('id-auth.user-statuses', {
      title: tval('User Statuses'),
      icon: 'TagOutlined',
      Component: UserStatusManagement,
      aclSnippet: 'pm.users.statuses',
      sort: 8,
    });

    this.app.systemSettingsManager.add('id-auth.user-status-histories', {
      title: tval('User Status Histories'),
      icon: 'HistoryOutlined',
      Component: UserStatusHistories,
      aclSnippet: 'pm.users.statuses',
      sort: 9,
    });

    this.userSettingsManager.add('user-change-password', {
      icon: 'LockOutlined',
      title: tval('Change password'),
      Component: ChangePassword,
    });

    this.userSettingsManager.add('user-profile', {
      icon: 'UserOutlined',
      title: tval('Edit profile'),
      Component: UserProfile,
    });

    const acl = this.app.pm.get(ACLPlugin);
    acl.rolesManager.add('users', {
      title: tval('Users'),
      Component: RoleUsersManager,
    });
  }
}

export default PluginUsersClient;
