import { Model } from '@tego/server';

export class DepartmentModel extends Model {
  getOwners() {
    return this.getMembers({
      through: {
        where: {
          isOwner: true,
        },
      },
    });
  }
}
