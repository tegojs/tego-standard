// @ts-ignore
import { name } from '../../package.json';

export { default } from './server';
export * from './server';
export { applyTenantFilterToContext } from './helpers/tenant-filter';

export const namespace = name;
