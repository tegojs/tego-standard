import type { Application, Collection } from '@tego/server';

import { SUMMARY_TYPE } from './constants';

type SummaryValue = string | number | boolean | null | undefined;

export type SummaryType = (typeof SUMMARY_TYPE)[keyof typeof SUMMARY_TYPE];

export interface SummaryDataSourceItem {
  key: string;
  label: string;
  type: SummaryType;
  value: Array<SummaryDataSourceItem> | SummaryValue | Array<SummaryValue>;
}

export interface ParamsType {
  summaryConfig: Array<string>;
  data: object;
  collection?: Collection;
  app?: Application;
}
