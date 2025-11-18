import { Application, BuiltInPlugin } from '@tachybase/client';

export const app = new Application({
  apiClient: {
    baseURL: ctx.tego.environment.getVariables().API_BASE_URL,
  },
  plugins: [BuiltInPlugin],
});

export default app.getRootComponent();
