import { DB_ERROR_MAP, NAMESPACE } from '../constants';

export class ErrorHandler {
  handlers = [];

  register(guard: (err) => boolean, render: (err, ctx) => void) {
    this.handlers.push({
      guard,
      render,
    });
  }

  defaultHandler(err, ctx) {
    let code = err.code;

    if (!code && err.message) {
      for (const { pattern, code: mappedCode } of DB_ERROR_MAP) {
        if (pattern.test(err.message)) {
          code = mappedCode;
          break;
        }
      }
    }

    ctx.status = err.statusCode || err.status || 500;
    ctx.body = {
      errors: [
        {
          message: ctx.i18n.t(`${code || 'unknown'}`, {
            defaultValue: err.message,
            ns: NAMESPACE,
          }),
          code: code,
        },
      ],
    };
  }

  middleware() {
    const self = this;
    return async function errorHandler(ctx, next) {
      try {
        await next();
      } catch (err) {
        ctx.logger.error(err.message, { method: 'error-handler', err: err.stack });

        for (const handler of self.handlers) {
          if (handler.guard(err)) {
            return handler.render(err, ctx);
          }
        }

        self.defaultHandler(err, ctx);
      }
    };
  }
}
