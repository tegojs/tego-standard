import { useContext, useEffect, useRef, useState } from 'react';
import { Pagination, useAPIClient, useCollectionManager, useCompile, useCurrentUserContext } from '@tachybase/client';
import { observer } from '@tachybase/schema';

import { useDeepCompareEffect } from 'ahooks';
import { Empty, List, Space, Tag } from 'antd-mobile';
import { set } from 'lodash';
import { useNavigate } from 'react-router-dom';

import { approvalStatusEnums } from '../../../../common/constants/approval-initiation-status-options';
import { useTranslation } from '../../../../locale';
import { ApprovalsSummary } from '../../common/approval-columns/summary.column';
import { fuzzySearch } from '../../common/FuzzySearch';
import { ApprovalPriorityType } from '../../constants';
import { InitiationsBlockContext } from '../InitiationsBlock';

export const ApprovalItem = observer((props) => {
  const { filter, params, tabKey } = props as any;
  const api = useAPIClient();
  const [data, setData] = useState([]);
  const { t } = useTranslation();
  const navigate = useNavigate();
  const user = useCurrentUserContext();
  const contextFilter = useContext(InitiationsBlockContext);
  const inputFilter = contextFilter['key'] === 'userInitiations' ? contextFilter['inputFilter'] : '';
  const cm = useCollectionManager();
  const compile = useCompile();
  const [page, setPage] = useState({
    pageSize: 10,
    current: 1,
  });
  const [loadData, setLoadData] = useState({
    loading: false,
    isEnd: false,
  });
  const loadMoreRef = useRef(null);
  const [filteredData, setFilteredData] = useState('');
  useEffect(() => {
    const mergerFilter = fuzzySearch({ filter, params: params?.[tabKey], input: inputFilter, isInitiationTable: true });
    if (JSON.stringify(mergerFilter) === filteredData) return;
    const serviceProps = {
      api,
      setData,
      user,
      filter: mergerFilter,
      t,
      cm,
      compile,
      page,
      setLoadData,
      isFilter: true,
    };
    changService(serviceProps);
    setFilteredData(JSON.stringify(mergerFilter));
    if (page.current !== 1) {
      setPage({ pageSize: 10, current: 1 });
    }
  }, [filter, params, inputFilter]);
  useEffect(() => {
    if (loadData.isEnd) return;
    if (page.current === 1) return;
    const mergerFilter = fuzzySearch({ filter, params: params?.[tabKey], input: inputFilter, isInitiationTable: true });
    const serviceProps = {
      api,
      setData,
      user,
      filter: mergerFilter,
      t,
      cm,
      compile,
      page,
      setLoadData,
    };
    changService(serviceProps);
  }, [page]);
  useEffect(() => {
    const el = loadMoreRef.current;
    if (!el) return;
    if (loadData.loading) return;
    if (!data.length) return;
    if (loadData.isEnd) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && !loadData.loading && !loadData.isEnd) {
          setPage((prev) => ({ pageSize: prev.pageSize, current: prev.current + 1 }));
          setLoadData({ loading: true, isEnd: false });
        }
      },
      { threshold: 1 },
    );

    observer.observe(el);

    return () => {
      observer.unobserve(el);
      observer.disconnect();
    };
  }, [data.length, loadData]);
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
        <Empty description={`${t('No data available')}`} />
      )}
      {data.length ? (
        <div ref={loadMoreRef} style={{ textAlign: 'center', padding: 20 }}>
          {loadData.loading ? `${t('Loading')}...` : loadData.isEnd ? `${t('Bottom reached')}` : `${t('Load more')}`}
        </div>
      ) : null}
    </div>
  );
});

const approvalTodoListStatus = (item, t) => {
  const { status } = item;
  return approvalStatusEnums.find((value) => value.value === status);
};

const changService = (serviceProps) => {
  const { api, setData, user, filter, t, compile, page, isFilter, setLoadData } = serviceProps;
  api
    .request({
      url: 'approvals:listCentralized',
      params: { pageSize: page.pageSize, page: page.current, appends: ['workflow'], filter, sort: ['-createdAt'] },
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
      if (isFilter) {
        setData(result);
      } else {
        setData((prev) => [...prev, ...result]);
      }
      if (page.current === res.data?.meta?.totalPage) {
        setLoadData({ loading: false, isEnd: true });
      } else {
        setLoadData({ loading: false, isEnd: false });
      }
    })
    .catch(() => {
      console.error;
    });
};
