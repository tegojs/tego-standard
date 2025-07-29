import { DataTypes, Field } from '@tego/server';

export class MarkdownVditorField extends Field {
  get dataType() {
    return DataTypes.TEXT;
  }
}
