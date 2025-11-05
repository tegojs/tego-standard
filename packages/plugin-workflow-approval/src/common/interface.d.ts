import type { Application, Collection } from '@tego/server';

import { SUMMARY_TYPE } from './constants';

export type SummaryType = (typeof SUMMARY_TYPE)[keyof typeof SUMMARY_TYPE];

export interface SummaryDataSourceItem {
  key: string;
  type: SummaryType;
  value: string | Array<SummaryDataSourceItem>;
}

export interface ParamsType {
  summaryConfig: Array<string>;
  data: object;
  collection?: Collection;
  app?: Application;
}
