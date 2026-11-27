import * as Rules from '../rules';

const validators = new Map(Object.entries(Rules));

/** Shared storage policy. Size is enforced by multipart limits, not a content filter. */
export function createUploadFileFilter(readRules: () => Record<string, unknown>) {
  return (_req, file, cb) => {
    let accepted: boolean;
    try {
      const input = readRules();
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new TypeError('Storage file rules must be an object');
      const rules = { ...input };
      delete rules.size;
      accepted = !Object.keys(rules).some((key) => {
        const validate = validators.get(key);
        return typeof validate !== 'function' || !Reflect.apply(validate, undefined, [file, rules[key]]);
      });
    } catch (error) {
      // Multer invokes filters from a stream event: throwing here would escape its promise.
      cb(error);
      return;
    }
    cb(null, accepted);
  };
}
