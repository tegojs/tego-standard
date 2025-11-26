/**
 * Simplified polyfill for i18next keyFromSelector function
 *
 * This function was introduced in i18next 25.5.0, but we're using 23.16.8.
 * This is a minimal stub implementation for type compatibility only.
 *
 * Note: This is only needed for TypeScript type definitions.
 * The function is not actually used in the codebase.
 *
 * IMPORTANT: We must bypass the alias to avoid circular dependency.
 * The alias in rsbuild.config.ts points 'i18next' to this file,
 * so we use a special import path to get the original module.
 */

// Import the original i18next using a special alias that bypasses the circular dependency
// The rspack config sets up 'i18next-original' to point to the actual i18next module
// @ts-ignore - Using special alias to avoid circular dependency
const i18nextOriginal = require('i18next-original');

// Re-export all named exports from the original i18next
// Manually re-export to avoid circular dependency with export * from
const {
  createInstance,
  init,
  use,
  changeLanguage,
  getFixedT,
  t,
  exists,
  getResource,
  addResource,
  addResources,
  addResourceBundle,
  removeResourceBundle,
  hasResourceBundle,
  getResourceBundle,
  store,
  services,
  format,
  setDefaultNamespace,
  getDefaultNamespace,
  hasLoadedNamespace,
  loadNamespaces,
  loadLanguages,
  reloadResources,
  isInitialized,
  language,
  languages,
  options,
  modules,
  resourceStore,
} = i18nextOriginal;

// Export named exports
export {
  createInstance,
  init,
  use,
  changeLanguage,
  getFixedT,
  t,
  exists,
  getResource,
  addResource,
  addResources,
  addResourceBundle,
  removeResourceBundle,
  hasResourceBundle,
  getResourceBundle,
  store,
  services,
  format,
  setDefaultNamespace,
  getDefaultNamespace,
  hasLoadedNamespace,
  loadNamespaces,
  loadLanguages,
  reloadResources,
  isInitialized,
  language,
  languages,
  options,
  modules,
  resourceStore,
};

// Export default
export default i18nextOriginal.default || i18nextOriginal;

// Note: We cannot use 'export type * from "i18next"' here because
// it would trigger the alias and cause circular dependency.
// TypeScript types will be inferred from the runtime exports above.

/**
 * Minimal stub implementation of keyFromSelector for type compatibility
 * This is a simplified version that extracts keys from selector functions
 */
export function keyFromSelector(selector: (t: any) => any): string {
  // Simple stub implementation - returns empty string as fallback
  // This is only for type compatibility, not for actual use
  try {
    const funcStr = selector.toString();
    const match = funcStr.match(/\$\.([\w.]+)|t\(['"]([^'"]+)['"]\)/);
    return match ? match[1] || match[2] || '' : '';
  } catch {
    return '';
  }
}
