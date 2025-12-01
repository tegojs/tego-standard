import { useEffect, useRef, useState } from 'react';
import { Pagination, useAPIClient, useCollectionManager, useCompile } from '@tachybase/client';
import { observer } from '@tachybase/schema';

import { useAsyncEffect } from 'ahooks';
import { Empty, List, Space, Tag } from 'antd-mobile';
import _ from 'lodash';
import { useNavigate } from 'react-router-dom';

import { approvalStatusEnums } from '../../../../common/constants/approval-initiation-status-options';
import { APPROVAL_TODO_STATUS } from '../../../../common/constants/approval-todo-status';
import { approvalTodoStatusOptions } from '../../../../common/constants/approval-todo-status-options';
import { useTranslation } from '../../../../locale';
import { ApprovalsSummary } from '../../common/approval-columns/summary.column';
import { fuzzySearch } from '../../common/FuzzySearch';
import { ApprovalPriorityType, ExecutionStatusOptions } from '../../constants';

export const TabApprovalItem = observer((props) => {
  const { filter, params, input, collectionName, tabKey } = props as any;

  const api = useAPIClient();
  const [data, setData] = useState([]);
  const { t } = useTranslation();
  const compile = useCompile();
  const navigate = useNavigate();
  const cm = useCollectionManager();
  const [page, setPage] = useState({
    pageSize: 10,
    current: 1,
  });
  const [loadData, setLoadData] = useState({
    loading: false,
    isEnd: false,
  });
  const loadMoreRef = useRef(null);
  const [user, setUser] = useState([]);
  const [filteredData, setFilteredData] = useState('');

  useEffect(() => {
    api.request({ url: 'users:list', params: { paginate: false } }).then((res) => setUser(res.data.data));
  }, []);
  useEffect(() => {
    const mergerFilter = fuzzySearch({ filter, params: params?.[tabKey], input, isInitiationTable: false });
    if (JSON.stringify(mergerFilter) === filteredData) return;
    const serviceProps = {
      api,
      mergerFilter,
      cm,
      compile,
      t,
      setData,
      input,
      page: { pageSize: 10, current: 1 },
      data,
      setLoadData,
      user,
      isFilter: true,
    };
    if (collectionName === 'approvalRecords') {
      changeApprovalRecordsService(serviceProps);
    } else if (collectionName === 'users_jobs') {
      changeUsersJobsService(serviceProps);
    } else if (collectionName === 'workflowNotice') {
      changeWorkflowNoticeService(serviceProps);
    }
    setFilteredData(JSON.stringify(mergerFilter));
    if (page.current !== 1) {
      setPage({ pageSize: 10, current: 1 });
    }
  }, [filter, params, input]);

  useEffect(() => {
    if (loadData.isEnd) return;
    if (page.current === 1) return;
    const mergerFilter = fuzzySearch({ filter, params: params?.[tabKey], input, isInitiationTable: false });
    const serviceProps = {
      api,
      mergerFilter,
      cm,
      compile,
      t,
      setData,
      input,
      page,
      data,
      setLoadData,
      user,
    };
    if (collectionName === 'approvalRecords') {
      changeApprovalRecordsService(serviceProps);
    } else if (collectionName === 'users_jobs') {
      changeUsersJobsService(serviceProps);
    } else if (collectionName === 'workflowNotice') {
      changeWorkflowNoticeService(serviceProps);
    }
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
    <div style={{ marginTop: '10px', minHeight: '70vh' }}>
      {data.length ? (
        <List style={{ '--font-size': '12px' }}>
          {data.map((item, index) => {
            return (
              <List.Item
                key={index}
                onClick={() => {
                  const url = `/mobile/approval/${collectionName}/${item.id}/${item.categoryTitle}/detailspage`;
                  navigate(url);
                }}
              >
                {/* <Badge color="#6ac3ff" content={Badge.dot} style={{ '--right': '100%' }}> */}
                <Space block>
                  <Tag color="success" fill="solid">
                    {item.approvalId}
                  </Tag>
                  {item.title}
                  <Tag color="primary" fill="solid">
                    {item.node?.title}
                  </Tag>
                  {item.statusTitle ? (
                    <Tag color={item.statusColor} fill="outline">
                      {item.statusIcon}
                      {item.statusTitle}
                    </Tag>
                  ) : null}

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
  const { workflow, execution, job, status } = item;
  if (
    (!(workflow != null && workflow.enabled) || (execution != null && execution.stauts) || job?.status) &&
    [APPROVAL_TODO_STATUS.ASSIGNED, APPROVAL_TODO_STATUS.PENDING].includes(status)
  ) {
    return { label: t('Unprocessed'), color: 'default' };
  } else {
    return approvalTodoStatusOptions.find((value) => value.value === status);
  }
};

const changeApprovalRecordsService = (serviceProps) => {
  const { api, mergerFilter, compile, t, setData, page, data, setLoadData, isFilter } = serviceProps;
  api
    .request({
      url: 'approvalRecords:listCentralized',
      params: {
        appends: ['approval.createdBy.nickname', 'execution', 'job', 'node', 'workflow', 'user'],
        filter: { ...mergerFilter },
        pageSize: page.pageSize,
        page: page.current,
        sort: ['-createdAt'],
      },
    })
    .then((res) => {
      const result = res.data?.data.map((item) => {
        const priorityType = ApprovalPriorityType.find((priorityItem) => priorityItem.value === item.snapshot.priority);
        const statusType = approvalTodoListStatus(item, t);
        const categoryTitle = item.workflow?.title;
        const collectionName = item.workflow?.config?.collection || item.execution?.context?.collectionName;

        const nickName = item.approval?.createdBy?.nickname;
        return {
          ...item,
          title: `${nickName}的${categoryTitle}`,
          categoryTitle: categoryTitle,
          statusTitle: compile(statusType?.label),
          statusColor: statusType?.color || 'default',
          summary: item.summary,
          collectionName: collectionName,
          priorityTitle: priorityType?.label,
          priorityColor: priorityType?.color,
        };
      });
      const filterData = [];
      if (isFilter) {
        filterData.push(...result);
      } else {
        filterData.push(...data, ...result);
      }
      setData([...filterData]);
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

const changeUsersJobsService = (serviceProps) => {
  const { api, compile, setData, mergerFilter, page, data, setLoadData, isFilter } = serviceProps;
  api
    .request({
      url: 'users_jobs:list',
      params: {
        pageSize: page.pageSize,
        page: page.current,
        filter: { ...mergerFilter },
        appends: ['execution', 'job', 'node', 'user', 'workflow'],
        sort: ['-createdAt'],
      },
    })
    .then((res) => {
      const result = res.data?.data.map((item) => {
        const priorityType = ApprovalPriorityType.find(
          (priorityItem) => priorityItem.value === item.execution.context?.data?.priority,
        );
        const statusType = ExecutionStatusOptions.find((value) => value.value === item.status);
        const categoryTitle = item.workflow?.title;
        const nickName = item.execution?.context?.data?.createdBy?.nickname;
        return {
          ...item,
          title: `${nickName}的${categoryTitle}`,
          categoryTitle: categoryTitle,
          statusTitle: compile(statusType?.label),
          statusColor: statusType?.color || 'default',
          statusIcon: statusType?.icon,
          summary: item.summary,
          priorityTitle: priorityType?.label,
          priorityColor: priorityType?.color,
        };
      });
      const filterData = [];
      if (isFilter) {
        filterData.push(...result);
      } else {
        filterData.push(...data, ...result);
      }
      setData(filterData);
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

export const changeWorkflowNoticeService = (serviceProps) => {
  const { api, compile, setData, mergerFilter, user, page, data, setLoadData, isFilter } = serviceProps;
  api
    .request({
      url: 'approvalCarbonCopy:listCentralized',
      params: {
        pageSize: page.pageSize,
        page: page.current,
        filter: { ...mergerFilter },
        appends: [
          'createdBy.id',
          'createdBy.nickname',
          'approval.status',
          'user.id',
          'user.nickname',
          'node.id',
          'node.title',
          'job.id',
          'job.status',
          'job.result',
          'workflow.id',
          'workflow.title',
          'workflow.enabled',
          'execution.id',
          'execution.status',
        ],
        sort: ['-createdAt'],
      },
    })
    .then((res) => {
      const result = res.data?.data.map((item) => {
        const priorityType = ApprovalPriorityType.find(
          (priorityItem) => priorityItem.value === item.snapshot?.priority,
        );
        const categoryTitle = item.workflow?.title;
        const collectionName = item.collectionName;
        const statusType = approvalStatusEnums.find((value) => value.value === item.approval?.status);
        const nickName = user.find((userItem) => userItem.id === item.snapshot?.createdById)?.nickname;
        return {
          ...item,
          title: `${nickName}的${categoryTitle}`,
          categoryTitle: categoryTitle,
          statusTitle: compile(statusType?.label),
          statusColor: statusType?.color || 'default',
          summary: item.summary,
          collectionName: collectionName,
          priorityTitle: priorityType?.label,
          priorityColor: priorityType?.color,
        };
      });
      const filterData = [];
      if (isFilter) {
        filterData.push(...result);
      } else {
        filterData.push(...data, ...result);
      }
      setData(filterData);
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
