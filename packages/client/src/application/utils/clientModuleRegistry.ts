let tachybaseClientExports: unknown;

export function registerTachybaseClientExports(exports: unknown) {
  tachybaseClientExports = exports;
}

export function getTachybaseClientExports() {
  return tachybaseClientExports;
}
