import { useContext, useEffect, useState } from 'react';
import { useAPIClient, useCollectionManager, useCompile, useCurrentUserContext } from '@tachybase/client';
import { observer } from '@tachybase/schema';

import { useDeepCompareEffect } from 'ahooks';
import { Empty, List, Space, Tag } from 'antd-mobile';
import { useNavigate } from 'react-router-dom';

import { approvalStatusEnums } from '../../../../common/constants/approval-initiation-status-options';
import { useTranslation } from '../../../../locale';
import { ApprovalsSummary } from '../../common/approval-columns/summary.column';
import { ApprovalPriorityType } from '../../constants';
import { InitiationsBlockContext } from '../InitiationsBlock';

export const ApprovalItem = observer((props) => {
  const { filter, params, tabKey } = props as any;
  const api = useAPIClient();
  const [defaultData, setDefaultData] = useState([]);
  const [data, setData] = useState([]);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUserContext();
  const contextFilter = useContext(InitiationsBlockContext);
  const inputFilter = contextFilter['key'] === 'userInitiations' ? contextFilter['inputFilter'] : '';
  const cm = useCollectionManager();
  const compile = useCompile();
  useDeepCompareEffect(() => {
    changService(api, setData, user, { ...params?.[tabKey], ...filter }, t, setDefaultData, cm, compile);
  }, [filter, params]);
  useEffect(() => {
    if (inputFilter && defaultData.length) {
      const filterData = defaultData.filter((value) => {
        // 检查标题
        if (value.title.includes(inputFilter)) {
          return true;
        }
        // 检查 summary 中的值
        const summary = value.summary;
        if (summary) {
          if (Array.isArray(summary)) {
            // 新版数组格式
            return summary.some((item: any) => {
              const itemValue = item?.value;
              if (Array.isArray(itemValue)) {
                return itemValue.some((v: any) => String(v ?? '').includes(inputFilter));
              }
              return String(itemValue ?? '').includes(inputFilter);
            });
          } else if (typeof summary === 'object') {
            // 旧版对象格式
            return Object.values(summary).some((v: any) => {
              const realValue = Object.prototype.toString.call(v) === '[object Object]' ? v?.['name'] : v;
              return String(realValue ?? '').includes(inputFilter);
            });
          }
        }
        return false;
      });

      filterData.sort((a, b) => {
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
      setData(filterData);
    } else {
      setData(defaultData);
    }
  }, [contextFilter]);
  return (
    <div style={{ minHeight: '73vh' }}>
      {data.length ? (
        <List style={{ '--font-size': '12px' }}>
          {data.map((item, index) => {
            return (
              <List.Item
                key={index}
                onClick={() => {
                  navigate(`/mobile/approval/${item.latestExecutionId}/page`);
                }}
              >
                {/* <Badge color="#6ac3ff" content={Badge.dot} style={{ '--right': '100%' }}> */}
                <Space block>
                  <Tag color="success" fill="solid">
                    {item.id}
                  </Tag>
                  {item.title}
                  <Tag color={item.statusColor} fill="outline">
                    {item.statusTitle}
                  </Tag>
                  <Tag color={item.priorityColor} fill="outline">
                    {item.priorityTitle}
                  </Tag>
                </Space>
                {/* </Badge> */}
                <ApprovalsSummary value={item.summary} collectionName={item.collectionName} />
              </List.Item>
            );
          })}
        </List>
      ) : (
        <Empty description="暂无数据" />
      )}
    </div>
  );
});

const approvalTodoListStatus = (item, t) => {
  const { status } = item;
  return approvalStatusEnums.find((value) => value.value === status);
};

const changService = (api, setData, user, filter, t, setDefaultData, cm, compile) => {
  api
    .request({
      url: 'approvals:listCentralized',
      params: { paginate: false, appends: ['workflow'], filter },
    })
    .then((res) => {
      const result = res.data?.data.map((item) => {
        const priorityType = ApprovalPriorityType.find((priorityItem) => priorityItem.value === item.data.priority);
        const statusType = approvalTodoListStatus(item, t);
        const categoryTitle = item.workflow?.title;
        const collectionName = item.workflow?.config?.collection || item.execution?.context?.collectionName;
        return {
          ...item,
          title: `${user.data.data.nickname}的${categoryTitle}`,
          categoryTitle: categoryTitle,
          statusTitle: compile(statusType?.label),
          statusColor: statusType?.color || 'default',
          summary: item.summary,
          collectionName: collectionName,
          priorityTitle: priorityType?.label,
          priorityColor: priorityType?.color,
        };
      });
      result.sort((a, b) => {
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
      });
      setData(result);
      setDefaultData(result);
    })
    .catch(() => {
      console.error;
    });
};
