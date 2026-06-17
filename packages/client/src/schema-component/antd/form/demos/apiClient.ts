import MockAdapter from 'axios-mock-adapter';

import { APIClient } from '../../../../api-client/APIClient';

export const apiClient = new APIClient();

const mock = new MockAdapter(apiClient.axios);

const REMOTE_DATA_DELAY_MS = 50;
const sleep = (value: number) => new Promise((resolve) => setTimeout(resolve, value));

mock.onGet('/posts:get').reply(async (config) => {
  await sleep(REMOTE_DATA_DELAY_MS);
  return [
    200,
    {
      data: {
        field1: 'uid',
      },
    },
  ];
});
