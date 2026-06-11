import { createRequire } from 'node:module';
import { createMockServer, createWsClient, MockServer, startServerWithRandomPort } from '@tachybase/test';
import type { Gateway as GatewayType } from '@tego/server';

const moduleRequire = createRequire(new URL('../../../package.json', import.meta.url));
const { AppSupervisor, Gateway, uid } = moduleRequire('@tego/server') as typeof import('@tego/server');

async function waitForMaintainingCode(wsClient, code: string, timeout = 10000) {
  try {
    const lastMessage = wsClient.lastMessage();
    if (lastMessage?.type === 'maintaining' && lastMessage?.payload?.code === code) {
      return lastMessage;
    }
  } catch (error) {
    // No message has been received yet.
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      wsClient.wsc.off('message', handleMessage);
    };
    const handleMessage = (data) => {
      const message = JSON.parse(data.toString());
      if (message?.type === 'maintaining' && message?.payload?.code === code) {
        cleanup();
        resolve(message);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for maintaining code ${code}`));
    }, timeout);

    wsClient.wsc.on('message', handleMessage);
  });
}

describe('gateway with multiple apps', () => {
  let app: MockServer;
  let gateway: GatewayType;
  let wsClient;

  beforeEach(async () => {
    gateway = Gateway.getInstance();

    app = await createMockServer({
      plugins: ['multi-app-manager'],
    });
  });

  afterEach(async () => {
    if (wsClient) {
      await wsClient.stop();
    }

    await app.destroy();
  });

  it('should boot main app with sub apps', async () => {
    // Verify main app is running
    expect(await app.isStarted()).toBe(true);

    const subAppName = `td_${uid()}`;

    // create app instance
    await app.db.getRepository('applications').create({
      values: {
        name: subAppName,
        options: {
          plugins: [],
        },
      },
      context: {
        waitSubAppInstall: true,
      },
    });

    const subApp = await AppSupervisor.getInstance().getApp(subAppName);
    await subApp.destroy();

    // start gateway
    const port = await startServerWithRandomPort(gateway.startHttpServer.bind(gateway));

    // create ws client
    wsClient = await createWsClient({
      serverPort: port,

      options: {
        headers: {
          'x-app': subAppName,
        },
      },
    });

    const lastMessage = await waitForMaintainingCode(wsClient, 'APP_RUNNING');

    expect(lastMessage).toMatchObject({
      type: 'maintaining',
      payload: {
        code: 'APP_RUNNING',
      },
    });
  });
});
