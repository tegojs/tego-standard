import { Module } from 'node:module';
import { isMainThread, workerData } from 'node:worker_threads';
import TachybaseGlobal from '@tachybase/globals';
import { defineLoader } from '@tachybase/loader';

import dayjs from 'dayjs';
import advancedFormat from 'dayjs/plugin/advancedFormat';
import calendar from 'dayjs/plugin/calendar';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import IsBetween from 'dayjs/plugin/isBetween';
import isoWeek from 'dayjs/plugin/isoWeek';
import IsSameOrAfter from 'dayjs/plugin/isSameOrAfter';
import isSameOrBefore from 'dayjs/plugin/isSameOrBefore';
import localeData from 'dayjs/plugin/localeData';
import quarterOfYear from 'dayjs/plugin/quarterOfYear';
import relativeTime from 'dayjs/plugin/relativeTime';
import tz from 'dayjs/plugin/timezone';
import updateLocale from 'dayjs/plugin/updateLocale';
import utc from 'dayjs/plugin/utc';
import weekday from 'dayjs/plugin/weekday';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import weekYear from 'dayjs/plugin/weekYear';

declare module 'node:module' {
  // 扩展 NodeJS.Module 静态属性
  export function _load(request: string, parent: NodeModule | null, isMain: boolean): any;
}

// 只有引擎运行模式下非主线程才加载
if (!isMainThread) {
  const globals = TachybaseGlobal.getInstance(workerData.initData);
  const lookingPaths = globals.get('WORKER_PATHS');
  const whitelists = new Set<string>(globals.get('WORKER_MODULES'));
  const originalLoad = Module._load;

  // 整个加载过程允许报错，保持和默认加载器一样的行为
  Module._load = defineLoader(whitelists, originalLoad, lookingPaths);
}

dayjs.extend(weekday);
dayjs.extend(localeData);
dayjs.extend(tz);
dayjs.extend(utc);
dayjs.extend(quarterOfYear);
dayjs.extend(isoWeek);
dayjs.extend(IsBetween);
dayjs.extend(IsSameOrAfter);
dayjs.extend(isSameOrBefore);
dayjs.extend(weekOfYear);
dayjs.extend(weekYear);
dayjs.extend(customParseFormat);
dayjs.extend(advancedFormat);
dayjs.extend(calendar);
dayjs.extend(relativeTime);
dayjs.extend(updateLocale);
