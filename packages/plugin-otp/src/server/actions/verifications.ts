import { randomInt, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { actions, Context, Next, Op } from '@tego/server';

import dayjs from 'dayjs';

import Plugin, { namespace } from '..';
import { CODE_STATUS_UNUSED } from '../constants';

const asyncRandomInt = promisify(randomInt);

export async function create(ctx: Context, next: Next) {
  const plugin = ctx.tego.pm.get('otp') as Plugin;

  const { values } = ctx.action.params;
  const interceptor = plugin.interceptors.get(values?.type);
  if (!interceptor) {
    return ctx.throw(400, 'Invalid action type');
  }

  const providerItem = await plugin.getDefault();
  if (!providerItem) {
    console.error(`[otp] no provider for action (${values.type}) provided`);
    return ctx.throw(500);
  }

  const receiver = interceptor.getReceiver(ctx);
  if (!receiver) {
    return ctx.throw(400, {
      code: 'InvalidReceiver',
      message: ctx.t('Not a valid cellphone number, please re-enter', { ns: namespace }),
    });
  }
  const VerificationModel = ctx.db.getModel('verifications');
  const record = await VerificationModel.findOne({
    where: {
      type: values.type,
      receiver,
      status: CODE_STATUS_UNUSED,
      expiresAt: {
        [Op.gt]: new Date(),
      },
    },
  });
  if (record) {
    const seconds = dayjs(record.get('expiresAt')).diff(dayjs(), 'seconds');
    // return ctx.throw(429, { code: 'RateLimit', message: ctx.t('Please don\'t retry in {{time}}', { time: moment().locale('zh').to(record.get('expiresAt')) }) });
    return ctx.throw(429, {
      code: 'RateLimit',
      message: ctx.t("Please don't retry in {{time}} seconds", { time: seconds, ns: namespace }),
    });
  }

  const code = (<number>await asyncRandomInt(999999)).toString(10).padStart(6, '0');
  if (interceptor.validate) {
    try {
      await interceptor.validate(ctx, receiver);
    } catch (err) {
      return ctx.throw(400, { code: 'InvalidReceiver', message: err.message });
    }
  }

  const ProviderType = plugin.providers.get(<string>providerItem.get('type'));
  const provider = new ProviderType(plugin, providerItem.get('options'));

  try {
    await provider.send(receiver, { code });
    console.log('verification code sent');
  } catch (error) {
    switch (error.name) {
      case 'InvalidReceiver':
        // TODO: message should consider email and other providers, maybe use "receiver"
        return ctx.throw(400, {
          code: 'InvalidReceiver',
          message: ctx.t('Not a valid cellphone number, please re-enter', { ns: namespace }),
        });
      case 'RateLimit':
        return ctx.throw(429, ctx.t('You are trying so frequently, please slow down', { ns: namespace }));
      default:
        console.error(error);
        return ctx.throw(
          500,
          ctx.t('Verification send failed, please try later or contact to administrator', { ns: namespace }),
        );
    }
  }

  const data = {
    id: randomUUID(),
    type: values.type,
    receiver,
    content: code,
    expiresAt: Date.now() + (interceptor.expiresIn ?? 60) * 1000,
    status: CODE_STATUS_UNUSED,
    providerId: providerItem.get('id'),
  };

  ctx.action.mergeParams(
    {
      values: data,
    },
    {
      values: 'overwrite',
    },
  );

  await actions.create(ctx, async () => {
    const { body: result } = ctx;
    ctx.body = {
      id: result.id,
      expiresAt: result.expiresAt,
    };

    return next();
  });
}
