import { createContext, useContext } from 'react';

interface ApprovalExecution {
  id: number;
  approval?: any;
  snapshot?: any;
  approvalExecution?: any;
  workflow?: any;
  status?: number;
  updatedAt?: string;
  user?: any;
  job?: any;
  execution?: any;
}

const ContextApprovalExecution = createContext<Partial<ApprovalExecution>>({} as any);

export const ProviderContextApprovalExecution = ContextApprovalExecution.Provider;

export function useContextApprovalExecution() {
  return useContext(ContextApprovalExecution);
}
