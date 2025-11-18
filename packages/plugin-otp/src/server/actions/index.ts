import * as verifications from './verifications';

function make(name, mod) {
  return Object.keys(mod).reduce(
    (result, key) => ({
      ...result,
      [`${name}:${key}`]: mod[key],
    }),
    {},
  );
}

export default function ({ app }) {
  app.resourcer.registerActions({
    ...make('verifications', verifications),
  });
}
