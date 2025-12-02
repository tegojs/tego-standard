// 根据一系列唯一性字段, 去重对象数组
// result = [{id:1,name,2,weight:10, time:1}]
// 用法示例: findUniquifyObjects(result, ['name', 'weight'], 'time', (a, b) => a - b);
export function findUniqueObjects(
  sourceArray = [],
  uniqueByArray: string[],
  compareByKey = '',
  compareByFunc = (a, b) => a - b,
): any[] {
  const uniqueMap = {};
  let result = [];
  sourceArray.forEach((obj) => {
    const uniqueKey = uniqueByArray.map((field) => obj[field]).join('|');
    const existingObj = uniqueMap[uniqueKey];

    if (!existingObj || compareByFunc(obj[compareByKey], existingObj[compareByKey]) > 0) {
      uniqueMap[uniqueKey] = obj;
    }
  });

  result = Object.values(uniqueMap);

  return result;
}

// 根据 workflowId 获取 workflow
export async function getWorkflow(ctx, workflowId) {
  if (workflowId) {
    return await ctx.db.getRepository('workflows').findOne({
      filterByTk: workflowId,
    });
  }
  return null;
}

// 根据 workflowKey 获取 最新可用的 workflow
export async function getWorkflowByKey(ctx, workflowKey) {
  if (workflowKey) {
    return await ctx.db.getRepository('workflows').findOne({
      filter: {
        key: workflowKey,
        enabled: true,
      },
    });
  }
  return null;
}
