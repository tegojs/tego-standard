type SummaryType = 'string' | 'date' | 'array';

export interface SummaryDataSourceItem {
  key: string;
  type: SummaryType;
  value: string | Array<SummaryDataSourceItem>;
}

export interface ParamsType {
  summaryConfig: Array<string>;
  data: object;
}
