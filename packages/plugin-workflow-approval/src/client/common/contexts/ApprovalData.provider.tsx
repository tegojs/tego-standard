import { createContext, useContext } from 'react';
import { useRecord } from '@tachybase/client';

import { Approval } from './ApprovalExecutions.provider';

export const ApprovalContext = createContext<Partial<Approval>>({});

export function useApproval() {
  return useContext(ApprovalContext);
}
export function ApprovalDataProvider(props) {
  const { value, useData = useRecord } = props;
  const recordData = useData();
  return (
    <ApprovalContext.Provider value={Object.keys(recordData).length ? recordData : value}>
      {props.children}
    </ApprovalContext.Provider>
  );
}
