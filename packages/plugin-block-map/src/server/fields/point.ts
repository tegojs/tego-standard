import { BaseColumnFieldOptions, DataTypes, Field, FieldContext, type Model } from '@tego/server';

import { isMysql, isPg, joinComma, toValue } from '../helpers';

class Point extends DataTypes.ABSTRACT {
  key = 'Point';
}

export class PointField extends Field {
  constructor(options?: any, context?: FieldContext) {
    const { name } = options;
    const normalize = (value: number[] | null | undefined) => {
      if (!value?.length) return null;
      if (isPg(context)) return joinComma(value);
      if (isMysql(context)) return { type: 'Point', coordinates: value };
      return value;
    };
    const setter = function (this: Model, value: number[] | null | undefined) {
      this.setDataValue(name, normalize(value));
    };
    super(
      {
        get() {
          const value = this.getDataValue(name);
          if (isPg(context)) {
            if (typeof value === 'string') {
              return toValue(value);
            }
            return value ? [value.x, value.y] : null;
          } else if (isMysql(context)) {
            return value?.coordinates || null;
          } else {
            return value;
          }
        },
        set: setter,
        ...options,
        // Pure storage normalization, bound to this exact setter; never run a setter to compare values.
        // 纯存储值归一化绑定本 setter，判等时不提前执行 setter。
        accessControlValueNormalization:
          context?.database.sequelize.getDialect() === 'sqlite' && !options.dataType
            ? Object.freeze({ setter, normalize })
            : undefined,
      },
      context,
    );
  }

  get dataType() {
    if (isPg(this.context)) {
      return Point;
    }
    if (isMysql(this.context)) {
      return DataTypes.GEOMETRY('POINT');
    } else {
      return DataTypes.JSON;
    }
  }
}

export interface PointFieldOptions extends BaseColumnFieldOptions {
  type: 'point';
}
