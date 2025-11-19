import React from 'react';
import { useCompile } from '@tachybase/client';
import { observer } from '@tachybase/schema';

import { Tag } from 'antd';

/**
 * 工作流分类列组件
 * - 直接展示后端返回的分类数据，不触发额外的 API 请求
 * - 数据由 listExtended action 提供，格式：{ id, name, color? }[]
 * - 与 data-source 模块的 CollectionCategory 组件设计类似
 */
export const WorkflowCategoryColumn = observer((props: any) => {
  const { value } = props;
  const compile = useCompile();

  if (!value || !Array.isArray(value) || value.length === 0) {
    return <span>-</span>;
  }

  return (
    <>
      {value.map((item: any) => {
        const categoryName = item?.name || item?.id;
        const categoryColor = item?.color;
        return (
          <Tag key={item?.id || categoryName} color={categoryColor}>
            {compile(categoryName)}
          </Tag>
        );
      })}
    </>
  );
});
