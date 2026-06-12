import { createRequire } from 'node:module';
import { createMockServer, createWsClient, MockServer, startServerWithRandomPort } from '@tachybase/test';
import type { Gateway as GatewayType } from '@tego/server';

type WsTestClient = Awaited<ReturnType<typeof createWsClient>>;

const moduleRequire = createRequire(new URL('../../../package.json', import.meta.url));
const { AppSupervisor, Gateway, uid } = moduleRequire('@tego/server') as typeof import('@tego/server');

function findMaintainingMessage(wsClient: WsTestClient, code: string) {
  const matchedMessage = wsClient.messages.find(
    (message) => message?.type === 'maintaining' && message?.payload?.code === code,
  );
  if (matchedMessage) {
    return matchedMessage;
  }

  if (wsClient.messages.length > 0) {
    const lastMessage = wsClient.lastMessage();
    if (lastMessage?.type === 'maintaining' && lastMessage?.payload?.code === code) {
      return lastMessage;
    }
  }
}

async function waitForMaintainingCode(wsClient: WsTestClient, code: string, timeout = 10000): Promise<unknown> {
  const existingMessage = findMaintainingMessage(wsClient, code);
  if (existingMessage) {
    return existingMessage;
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      wsClient.wsc.off('message', handleMessage);
    };
    const handleMessage = (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
      } catch (error) {
        return;
      }
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

    const matchedAfterListener = findMaintainingMessage(wsClient, code);
    if (matchedAfterListener) {
      cleanup();
      resolve(matchedAfterListener);
    }
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
