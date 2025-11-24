import { resolve } from 'node:path';
import { InjectedPlugin, Plugin } from '@tego/server';

import _ from 'lodash';

import { CloudLibrariesController } from './actions/cloud-libraries-controller';
import { CloudCompiler } from './services/cloud-compiler';
import { CloudLibrariesService } from './services/cloud-libraries-service';

@InjectedPlugin({
  Controllers: [CloudLibrariesController],
  Services: [CloudLibrariesService, CloudCompiler],
})
export class ModuleCloudComponentServer extends Plugin {
  async load() {}
}

export default ModuleCloudComponentServer;
