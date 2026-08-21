import type { PluginSettingsPageType } from '../../application';

export function getVisibleSystemSettingsItems(
  settings: Partial<PluginSettingsPageType>[],
): Partial<PluginSettingsPageType>[] {
  return settings
    .filter((item) => !item.hideInMenu && !item.path?.includes(':'))
    .map(({ children: rawChildren, ...item }) => {
      const children = rawChildren?.length ? getVisibleSystemSettingsItems(rawChildren) : [];
      return children.length ? { ...item, children } : item;
    });
}
