import { assign, RoleActionParams } from '@tego/server';

export class RoleActionParamsMerge {
  public static merge(params: RoleActionParams[]): RoleActionParams {
    const result: RoleActionParams = {};
    for (const item of params) {
      assign(item, result, {
        filter: 'orMerge',
        fields: 'union',
        own: (x, y) => x || y,
        whitelist: 'union',
        blacklist: 'intersect',
      });
    }
    return result;
  }
}
