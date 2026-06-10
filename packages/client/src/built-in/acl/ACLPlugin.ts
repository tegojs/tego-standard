import { Plugin } from '../../application/Plugin';
import { ACLCollectionFieldProvider } from './ACLCollectionFieldProvider';
import { ACLActionProvider, ACLCollectionProvider, ACLMenuItemProvider } from './ACLProvider';

export class ACLPlugin extends Plugin {
  async load() {
    this.app.addComponents({
      ACLCollectionFieldProvider,
      ACLActionProvider,
      ACLMenuItemProvider,
      ACLCollectionProvider,
    });
  }
}
