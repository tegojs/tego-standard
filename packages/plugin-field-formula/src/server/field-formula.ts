import { BaseFieldOptions, DataTypes, evaluators, Field } from '@tego/server';

import { getAppendsFromExpression, toDbType } from '../utils';

export interface FormulaFieldOptions extends BaseFieldOptions {
  type: 'formula';
  engine: string;
  expression: string;
}

const DataTypeMap = {
  boolean: DataTypes.BOOLEAN,
  integer: DataTypes.INTEGER,
  bigInt: DataTypes.BIGINT,
  double: DataTypes.DOUBLE,
  decimal: DataTypes.DECIMAL,
  string: DataTypes.STRING,
  date: DataTypes.DATE(3),
};

export class FormulaField extends Field {
  get dataType() {
    const { dataType } = this.options;
    return DataTypeMap[dataType] ?? DataTypes.DOUBLE;
  }

  calculate(scope) {
    const { expression, engine = 'math.js', dataType = 'double' } = this.options;
    const evaluate = evaluators.get(engine);
    if (!evaluate) {
      console.error(`Formula evaluator "${engine}" is not registered.`);
      return null;
    }
    try {
      const result = evaluate(expression, scope);
      return toDbType(result, dataType);
    } catch (e) {
      console.error(e);
    }
    return null;
  }

  getCalculationScope = async (instance, options?) => {
    const appends = getAppendsFromExpression(this.options.expression);
    const scope = instance.toJSON();

    if (!appends.length) {
      return scope;
    }

    const pk = this.collection.model.primaryKeyAttribute;
    const pkValue = instance.get(pk) ?? scope[pk];

    if (pkValue) {
      const record = await this.collection.repository.findOne({
        filterByTk: pkValue,
        appends,
        transaction: options?.transaction,
      });
      if (record) {
        return { ...record.toJSON(), ...scope };
      }
    }

    for (const append of appends) {
      if (scope[append]) {
        continue;
      }
      const field = this.collection.getField(append);
      const target = field?.target ?? field?.options?.target;
      if (!target) {
        continue;
      }
      const fkField = field.options?.foreignKey ?? field.foreignKey ?? `${append}Id`;
      const fkValue = scope[fkField];
      if (fkValue == null) {
        continue;
      }
      const targetCollection = this.database.getCollection(target);
      if (!targetCollection) {
        continue;
      }
      const targetRecord = await targetCollection.repository.findOne({
        filterByTk: fkValue,
        transaction: options?.transaction,
      });
      if (targetRecord) {
        scope[append] = targetRecord.toJSON();
      }
    }

    return scope;
  };

  calculateField = async (instance, options?) => {
    const { name } = this.options;
    const scope = await this.getCalculationScope(instance, options);
    const result = this.calculate(scope);
    instance.set(name, result);
  };

  bind() {
    super.bind();
    this.on('beforeSave', this.calculateField);
  }

  unbind() {
    super.unbind();
    this.off('beforeSave', this.calculateField);
  }
}
