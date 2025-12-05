import { Context } from '@tego/server';

const MiddlewareOrderResource = {
  name: 'middlewares',
  actions: {
    get: async (ctx: Context, next: () => Promise<any>) => {
      const app = ctx.tego as any;
      const data = [
        {
          name: 'use-middleware',
          items: app._middleware._items,
        },
        {
          name: 'acl-middlewares',
          items: ctx.tego.acl.middlewares._items,
        },
        {
          name: 'resourcer-middlewares',
          items: (ctx.tego.resourcer as any).middlewares._items,
        },
      ];
      const mergedItems = [];
      data.forEach((group) => {
        group.items.forEach((item) => {
          item.belongto = group.name;

          item.path =
            ctx.tego.middlewareSourceMap.get(item.node) ||
            ctx.tego.resourcer.middlewareSourceMap.get(item.node) ||
            ctx.tego.acl.middlewareSourceMap.get(item.node) ||
            'Unknown Path'; // 默认值

          mergedItems.push(item);
        });
      });
      mergedItems.forEach((middleware) => {
        middleware.files = [];
      });
      mergedItems
        .filter((middleware) => middleware.belongto === 'acl-middlewares')
        .forEach((aclMiddleware) => {
          const aclGroup = mergedItems.find((middleware) => middleware.group === 'acl');
          if (aclGroup) {
            aclGroup.files.push(aclMiddleware);
          }
        });

      mergedItems
        .filter((middleware) => middleware.belongto === 'resourcer-middlewares')
        .forEach((resourcerMiddleware) => {
          const restAPIGroup = mergedItems.find((middleware) => middleware.group === 'dataSource');
          if (restAPIGroup) {
            restAPIGroup.files.push(resourcerMiddleware);
          }
        });

      const useMiddlewares = mergedItems.filter((middleware) => middleware.belongto === 'use-middleware');

      function simplifyMiddlewareStructure(middleware) {
        return {
          name: middleware.group,
          path: middleware.path,
          seq: middleware.seq,
          belongto: middleware.belongto,
          files: middleware.files.map(simplifyMiddlewareStructure),
        };
      }

      const simplifiedResult = useMiddlewares.map(simplifyMiddlewareStructure);
      ctx.body = simplifiedResult;
    },
  },
  only: ['get'],
};

export { MiddlewareOrderResource };
