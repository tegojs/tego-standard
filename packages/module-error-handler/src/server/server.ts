import { Schema } from '@tachybase/schema';
import { BaseError, Plugin } from '@tego/server';

import lodash from 'lodash';

import { ErrorHandler } from './error-handler';
import enUS from './locale/en_US';
import zhCN from './locale/zh_CN';

export class PluginErrorHandler extends Plugin {
  errorHandler: ErrorHandler = new ErrorHandler();
  i18nNs = 'error-handler';

  beforeLoad() {
    this.registerSequelizeValidationErrorHandler();
    this.registerJWTErrorHandler();
    this.registerPermissionDeniedErrorHandler();
  }

  registerSequelizeValidationErrorHandler() {
    const findFieldTitle = (instance, path, tFunc, ctx) => {
      if (!instance) {
        return path;
      }

      const model = instance.constructor;
      const dataSourceKey = ctx.get('x-data-source');
      const dataSource = ctx.app.dataSourceManager.dataSources.get(dataSourceKey);
      const database = dataSource ? dataSource.collectionManager.db : ctx.db;

      const collection = database.modelCollection.get(model);

      const field = collection.getField(path);
      const fieldOptions = Schema.compile(field?.options, { t: tFunc });
      const title = lodash.get(fieldOptions, 'uiSchema.title', path);
      return title;
    };

    this.errorHandler.register(
      (err) => err?.errors?.length && err instanceof BaseError,
      (err, ctx) => {
        ctx.body = {
          errors: err.errors.map((err) => {
            return {
              message: ctx.i18n.t(err.type, {
                ns: this.i18nNs,
                field: findFieldTitle(err.instance, err.path, ctx.i18n.t, ctx),
              }),
            };
          }),
        };
        ctx.status = 400;
      },
    );
  }

  registerJWTErrorHandler() {
    this.errorHandler.register(
      (err) => {
        // 检查是否是 JWT 相关错误
        const jwtErrorMessages = ['jwt expired', 'jwt malformed', 'invalid token', 'invalid signature'];
        return err.message && jwtErrorMessages.some((msg) => err.message.toLowerCase().includes(msg.toLowerCase()));
      },
      (err, ctx) => {
        let code = 'JWT_EXPIRED';
        let messageKey = 'JWT_EXPIRED';

        // 根据错误消息确定错误码和翻译键
        const errMsg = err.message.toLowerCase();
        if (errMsg.includes('expired')) {
          code = 'JWT_EXPIRED';
          messageKey = 'JWT_EXPIRED';
        } else if (errMsg.includes('malformed')) {
          code = 'JWT_MALFORMED';
          messageKey = 'JWT_MALFORMED';
        } else if (errMsg.includes('invalid signature')) {
          code = 'JWT_INVALID_SIGNATURE';
          messageKey = 'JWT_INVALID_SIGNATURE';
        } else if (errMsg.includes('invalid token')) {
          code = 'JWT_INVALID_TOKEN';
          messageKey = 'JWT_INVALID_TOKEN';
        }

        ctx.status = err.statusCode || err.status || 401;
        ctx.body = {
          errors: [
            {
              message: ctx.i18n.t(messageKey, {
                ns: this.i18nNs,
                defaultValue: err.message,
              }),
              code: code,
            },
          ],
        };
      },
    );
  }

  registerPermissionDeniedErrorHandler() {
    this.errorHandler.register(
      (err) => {
        // 检查是否是权限拒绝错误
        // 1. HTTP 状态码是 403
        // 2. 或者错误消息包含 "permission denied" 或 "no permissions"
        const is403 = err.statusCode === 403 || err.status === 403;
        const permissionDeniedMessagesEn = ['permission denied', 'no permissions'];
        const permissionDeniedMessagesZh = ['没有权限', '无权限'];
        const hasPermissionMessage =
          err.message &&
          (
            permissionDeniedMessagesEn.some((msg) => err.message.toLowerCase().includes(msg.toLowerCase())) ||
            permissionDeniedMessagesZh.some((msg) => err.message.includes(msg))
          );

        return is403 || hasPermissionMessage;
      },
      (err, ctx) => {
        let code = 'PERMISSION_DENIED';
        let messageKey = 'PERMISSION_DENIED';

        // 如果错误已经有 code，使用原有的 code
        if (err.code) {
          code = err.code;
          messageKey = err.code;
        }

        ctx.status = err.statusCode || err.status || 403;
        ctx.body = {
          errors: [
            {
              message: ctx.i18n.t(messageKey, {
                ns: this.i18nNs,
                defaultValue: err.message || 'Permission denied',
              }),
              code: code,
            },
          ],
        };
      },
    );
  }

  async load() {
    this.app.i18n.addResources('zh-CN', this.i18nNs, zhCN);
    this.app.i18n.addResources('en-US', this.i18nNs, enUS);
    this.app.use(this.errorHandler.middleware(), { before: 'cors', tag: 'errorHandler' });
  }
}
