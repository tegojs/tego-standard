import { InjectedPlugin, Plugin } from '@tego/server';

import _ from 'lodash';

import { CloudLibrariesController } from './actions/cloud-libraries-controller';
import { CloudCompiler } from './services/cloud-compiler';
import { CloudLibrariesService } from './services/cloud-libraries-service';
import { RemoteCodeFetcher } from './services/remote-code-fetcher';

@InjectedPlugin({
  Controllers: [CloudLibrariesController],
  Services: [CloudLibrariesService, CloudCompiler, RemoteCodeFetcher],
})
export class ModuleCloudComponentServer extends Plugin {}

export default ModuleCloudComponentServer;
