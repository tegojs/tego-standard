const parsedAssertionTimeout = Number.parseInt(process.env.TEST_ASSERTION_TIMEOUT_MS ?? '', 10);

export const TEST_ASSERTION_TIMEOUT =
  Number.isFinite(parsedAssertionTimeout) && parsedAssertionTimeout > 0 ? parsedAssertionTimeout : 10000;
