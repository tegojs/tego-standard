import { actions } from '@tego/server';

import { MESSAGES_UPDATE_BADGE_COUNT } from '../../common/constants';

export const messages = {
  async update(ctx, next) {
    await actions.update(ctx, next);

    ctx.tego.noticeManager.notify(MESSAGES_UPDATE_BADGE_COUNT, {
      msg: MESSAGES_UPDATE_BADGE_COUNT,
    });
  },
};
