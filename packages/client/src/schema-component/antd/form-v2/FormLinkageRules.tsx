import React, { useEffect } from 'react';
import { Form as FormilyForm, onFieldInit, reaction, uid } from '@tachybase/schema';
import { getValuesByPath } from '@tego/client';

import { ActionType } from '../../../schema-settings/LinkageRules/type';
import useLocalVariables from '../../../variables/hooks/useLocalVariables';
import useVariables from '../../../variables/hooks/useVariables';
import { VariableOption, VariablesContextType } from '../../../variables/types';
import { getPath } from '../../../variables/utils/getPath';
import { getVariableName } from '../../../variables/utils/getVariableName';
import { isVariable, REGEX_OF_VARIABLE } from '../../../variables/utils/isVariable';
import { getInnermostKeyAndValue, getTargetField } from '../../common/utils/uitls';
import { collectFieldStateOfLinkageRules, getTempFieldState } from './utils';

interface FormLinkageRulesProps {
  children: React.ReactNode;
  form: FormilyForm;
  linkageRules: any[];
}

export const FormLinkageRules = ({ children, form, linkageRules }: FormLinkageRulesProps) => {
  const variables = useVariables();
  const localVariables = useLocalVariables({ currentForm: form });

  useEffect(() => {
    const id = uid();
    const disposes = [];

    form.addEffects(id, () => {
      linkageRules.forEach((rule) => {
        rule.actions?.forEach((action) => {
          if (action.targetFields?.length) {
            const fields = action.targetFields.join(',');

            // 之前使用的 `onFieldReact` 有问题，没有办法被取消监听，所以这里用 `onFieldInit` 和 `reaction` 代替
            onFieldInit(`*(${fields})`, (field: any, form) => {
              field['initStateOfLinkageRules'] = {
                display: field.initStateOfLinkageRules?.display || getTempFieldState(true, field.display),
                required: field.initStateOfLinkageRules?.required || getTempFieldState(true, field.required || false),
                pattern: field.initStateOfLinkageRules?.pattern || getTempFieldState(true, field.pattern),
                value:
                  field.initStateOfLinkageRules?.value || getTempFieldState(true, field.value || field.initialValue),
              };

              disposes.push(
                reaction(
                  () => {
                    const fieldValuesInCondition = getFieldValuesInCondition({ linkageRules, formValues: form.values });
                    const variableValuesInCondition = getVariableValuesInCondition({ linkageRules, localVariables });
                    const variableValuesInExpression = getVariableValuesInExpression({ action, localVariables });

                    return [fieldValuesInCondition, variableValuesInCondition, variableValuesInExpression]
                      .map((item) => JSON.stringify(item))
                      .join(',');
                  },
                  getSubscriber(action, field, rule, variables, localVariables),
                  { fireImmediately: true },
                ),
              );
            });
          }
        });
      });
    });

    return () => {
      form.removeEffects(id);
      disposes.forEach((dispose) => {
        dispose();
      });
    };
  }, [form, linkageRules, localVariables, variables]);

  return <>{children}</>;
};

function getSubscriber(
  action: any,
  field: any,
  rule: any,
  variables: VariablesContextType,
  localVariables: VariableOption[],
): (value: string, oldValue: string) => void {
  return () => {
    collectFieldStateOfLinkageRules({
      operator: action.operator,
      value: action.value,
      field,
      condition: rule.condition,
      variables,
      localVariables,
    });

    setTimeout(async () => {
      const fieldName = getFieldNameByOperator(action.operator);

      if (!field.stateOfLinkageRules?.[fieldName]) {
        return;
      }

      let stateList = field.stateOfLinkageRules[fieldName];

      stateList = await Promise.all(stateList);
      stateList = stateList.filter((v) => v.condition);

      const lastState = stateList[stateList.length - 1];

      if (fieldName === 'value') {
        if (stateList.length > 1) {
          field.value = lastState.value;
        }
      } else {
        field[fieldName] = lastState?.value;
        if (fieldName === 'display' && lastState?.value === 'none') {
          field.value = undefined;
        }
      }

      field.stateOfLinkageRules[fieldName] = null;
    });
  };
}

function getFieldNameByOperator(operator: ActionType) {
  switch (operator) {
    case ActionType.Required:
    case ActionType.InRequired:
      return 'required';
    case ActionType.Visible:
    case ActionType.None:
    case ActionType.Hidden:
      return 'display';
    case ActionType.Editable:
    case ActionType.ReadOnly:
    case ActionType.ReadPretty:
      return 'pattern';
    case ActionType.Value:
      return 'value';
    default:
      return null;
  }
}

function getFieldValuesInCondition({ linkageRules, formValues }) {
  return linkageRules.map((rule) => {
    const run = (condition) => {
      const type = Object.keys(condition)[0] || '$and';
      const conditions = condition[type];

      return conditions
        .map((condition) => {
          if ('$and' in condition || '$or' in condition) {
            return run(condition);
          }

          const path = getTargetField(condition).join('.');
          return getValuesByPath(formValues, path);
        })
        .filter(Boolean);
    };

    return run(rule.condition);
  });
}

function getVariableValuesInCondition({
  linkageRules,
  localVariables,
}: {
  linkageRules: any[];
  localVariables: VariableOption[];
}) {
  return linkageRules.map((rule) => {
    const type = Object.keys(rule.condition)[0] || '$and';
    const conditions = rule.condition[type];

    return conditions
      .map((condition) => {
        const jsonlogic = getInnermostKeyAndValue(condition);
        if (!jsonlogic) {
          return null;
        }
        if (isVariable(jsonlogic.value)) {
          return getVariableValue(jsonlogic.value, localVariables);
        }

        return jsonlogic.value;
      })
      .filter(Boolean);
  });
}

function getVariableValuesInExpression({ action, localVariables }) {
  const actionValue = action.value;
  const mode = actionValue?.mode;
  const value = actionValue?.value || actionValue?.result;

  if (mode !== 'express') {
    return;
  }

  if (value == null) {
    return;
  }

  return value
    .match(REGEX_OF_VARIABLE)
    ?.map((variableString: string) => {
      return getVariableValue(variableString, localVariables);
    })
    .filter(Boolean);
}

function getVariableValue(variableString: string, localVariables: VariableOption[]) {
  if (!isVariable(variableString)) {
    return;
  }

  const variableName = getVariableName(variableString);
  const ctx = {
    [variableName]: localVariables.find((item) => item.name === variableName)?.ctx,
  };

  return getValuesByPath(ctx, getPath(variableString));
}
