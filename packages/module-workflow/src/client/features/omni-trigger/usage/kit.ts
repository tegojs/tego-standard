import { Plugin, useCollection } from '@tachybase/client';

import { tval } from '../../../locale';
import { APIRegularInitializer } from './APIRegular.schema';
import { APIRegularActionSettings } from './APIRegular.setting';
import { usePropsAPIRegular } from './hooks';

export class KitAPIRegularUsage extends Plugin {
  async load() {
    this.app.addComponents({
      APIRegularInitializer,
    });

    this.app.addScopes({
      usePropsAPIRegular,
    });

    this.app.schemaSettingsManager.add(APIRegularActionSettings);
  }
}
