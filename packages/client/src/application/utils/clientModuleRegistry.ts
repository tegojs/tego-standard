let tachybaseClientExports: unknown;

export function registerTachybaseClientExports(exports: unknown) {
  tachybaseClientExports = exports;
}

export function getTachybaseClientExports() {
  if (tachybaseClientExports == null) {
    throw new Error(
      '@tachybase/client exports have not been registered. Ensure the package root entry is loaded first.',
    );
  }

  return tachybaseClientExports;
}
