import { createContext, useContext } from 'react';
import { useAPIClient } from '@tachybase/client';

interface ReportGeneratorContextType {
  generateReport: (params: {
    prompt: string;
    collectionName?: string;
    filters?: any;
    fields?: string[];
    format?: 'xlsx';
  }) => Promise<any>;
  listCollections: () => Promise<any>;
}

const ReportGeneratorContext = createContext<ReportGeneratorContextType>(null);

export const useReportGenerator = () => {
  return useContext(ReportGeneratorContext);
};

export const ReportGeneratorProvider = ({ children }) => {
  const api = useAPIClient();

  const generateReport = async (params: {
    prompt: string;
    collectionName?: string;
    filters?: any;
    fields?: string[];
    format?: 'xlsx';
  }) => {
    const response = await api.request({
      url: 'reportGenerator:generate',
      method: 'post',
      data: params,
    });
    return response.data;
  };

  const listCollections = async () => {
    const response = await api.request({
      url: 'reportGenerator:listCollections',
      method: 'get',
    });
    return response.data;
  };

  return (
    <ReportGeneratorContext.Provider value={{ generateReport, listCollections }}>
      {children}
    </ReportGeneratorContext.Provider>
  );
};
