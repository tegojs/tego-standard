import _ from 'lodash';

import { Application } from '../application';

export interface VariableManagerOptions {
  blockName: string;
  addOptions: Function;
}

export class VariableManager {
  protected variableInstancesMap: Record<string, VariableManagerOptions> = {};
  public app: Application;
  constructor(_variableOpions: Record<string, VariableManagerOptions>, app: Application) {
    this.app = app;
    Object.entries(_variableOpions || {}).forEach(([name, variableOptions]) => {
      this.addVariableOption(name, variableOptions);
    });
  }

  variableOptions() {
    return this.variableInstancesMap;
  }

  getVariableOption(name: string) {
    const option = this.variableInstancesMap[name];
    return option;
  }

  removeVariableOption(keys: string[]) {
    keys.forEach((key) => {
      delete this.variableInstancesMap[key];
    });
  }

  addVariableOption(name: string, options: VariableManagerOptions) {
    this.variableInstancesMap[name] = options;
    return this.variableInstancesMap[name];
  }
}
