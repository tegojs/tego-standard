import { describe, expect, it } from 'vitest';

import * as authModule from '../index';

describe('@tachybase/module-auth source entry', () => {
  it.each(['isAuthenticationSecretKey', 'redactSensitiveAuthenticationData', 'serializeAuthenticatedUser'])(
    'should export the %s server utility',
    (exportName) => {
      expect(authModule[exportName]).toBeTypeOf('function');
    },
  );
});
