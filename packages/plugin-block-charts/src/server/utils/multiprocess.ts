export const isMain = () => {
  return currentProcessNum() === '0';
};

export const currentProcessNum = () => {
  if (typeof ctx.tego.environment.getVariables().NODE_APP_INSTANCE === 'undefined') {
    return '0';
  } else {
    return ctx.tego.environment.getVariables().NODE_APP_INSTANCE;
  }
};
