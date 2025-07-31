import { lodash } from '@tego/client';

export const debounceClick = lodash.debounce((parentForm, actionKey, keyName, headerValue) => {
  const { actions } = parentForm.values || {};

  parentForm.setValuesIn('actions', {
    ...actions,
    [actionKey]: {
      ...actions?.[actionKey],
      [keyName]: headerValue,
    },
  });
}, 400);
