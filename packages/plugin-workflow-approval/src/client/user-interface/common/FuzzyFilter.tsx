/** 构造模糊查询的参数 */
export function getFuzzyFilter(queryValue, isInitiationTable) {
  if (!queryValue) {
    return {};
  }

  // /^\d{4}-\d{2}-\d{2}/
  const searchArr: any[] = [];
  // 日期类型的查询
  if (/^\d{4}-\d{2}-\d{2}/.test(queryValue)) {
    // 转换为 utc 查询
    queryValue = new Date(queryValue).toISOString().substring(0, 10);
    // 同时加入 createdAt 查询
    searchArr.push({
      createdAt: {
        $dateOn: queryValue,
      },
    });
  }

  searchArr.push(
    {
      summary: {
        $containsJsonbValue: queryValue,
      },
    },
    // 字符串类型的查询
    {
      createdBy: {
        nickname: {
          $includes: queryValue,
        },
      },
    },
  );

  // 发起审批没有 user 字段, 只有审批抄送和审批待办有此字段
  if (!isInitiationTable) {
    searchArr.push({
      user: {
        nickname: {
          $includes: queryValue,
        },
      },
    });
  }

  // 数值类型的查询
  if (queryValue && Number.isInteger(Number(queryValue))) {
    // 所有对用户的界面显示的统一编号, 为发起审批的编号, 所以查询时候要区分
    searchArr.push({
      [isInitiationTable ? 'id' : 'approvalId']: {
        $eq: queryValue,
      },
    });
  }
  return {
    $or: searchArr,
  };
}
