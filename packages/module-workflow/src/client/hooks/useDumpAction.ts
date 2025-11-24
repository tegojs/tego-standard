import { useDataBlockResource, useFilterByTk } from '@tachybase/client';

import { message } from 'antd';
import { saveAs } from 'file-saver';
import { useTranslation } from 'react-i18next';

/**
 * 工作流导出的 useAction hook
 * 将工作流数据导出为 JSON 文件
 */
export function useDumpAction() {
  const { t } = useTranslation();
  const resource = useDataBlockResource();
  const filterByTk = useFilterByTk();

  return {
    async run() {
      const { data } = await resource.dump({ filterByTk });
      const blob = new Blob([JSON.stringify(data.data, null, 2)], {
        type: 'application/json',
      });
      saveAs(blob, data.data.title + '-' + data.data.key + '.json');
      message.success(t('Operation succeeded'));
    },
  };
}
