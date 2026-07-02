import { setValidateLanguage } from '@tachybase/schema';

import { App, ConfigProvider } from 'antd';
import dayjs from 'dayjs';

import type { Application } from '../../application/Application';
import { Plugin } from '../../application/Plugin';
import { dayjsLocale } from '../../locale';
import { loadConstrueLocale } from './loadConstrueLocale';

export function handleUnauthorizedLocaleLoad(app: Application) {
  const auth = app.apiClient.auth;
  auth.setToken(null);
  auth.setRole?.(null);
  auth.setAuthenticator?.(null);

  const signInPath = app.getHref('signin');
  if (window.location.pathname.toLowerCase() === signInPath.toLowerCase()) {
    return signInPath;
  }

  return `${signInPath}?redirect=${window.location.pathname}${window.location.search}`;
}

export class LocalePlugin extends Plugin {
  locales: any = {};
  async afterAdd() {
    const api = this.app.apiClient;
    const locale = api.auth.locale;
    try {
      const res = await api.request({
        url: 'app:getLang',
        params: {
          locale,
        },
        skipNotify: true,
        headers: {
          'X-Role': 'anonymous',
        },
      });
      const data = res?.data;
      this.locales = data?.data || {};
      this.app.use(ConfigProvider, { locale: this.locales.antd, popupMatchSelectWidth: false });
      this.app.use(App, { component: false });
      if (data?.data?.lang) {
        api.auth.setLocale(data?.data?.lang);
        this.app.i18n.changeLanguage(data?.data?.lang);
      }
      Object.keys(data?.data?.resources || {}).forEach((key) => {
        this.app.i18n.addResources(data?.data?.lang, key, data?.data?.resources[key] || {});
      });
      setValidateLanguage(data?.data?.lang);
      loadConstrueLocale(data?.data);
      const dayjsLang = dayjsLocale[data?.data?.lang] || 'en';
      await import(`dayjs/locale/${dayjsLang}.js`);
      dayjs.locale(dayjsLang);

      // 防止数据源没有日期值的时候, 界面显示 Invalid Date
      const localeSetting = { invalidDate: '-' };
      dayjs.updateLocale(dayjsLang, localeSetting);

      window['cronLocale'] = data?.data?.cron;
    } catch (error) {
      (() => {})();
      if (error?.response?.status === 401) {
        window.location.href = handleUnauthorizedLocaleLoad(this.app);
      }
      throw error;
    }
  }
}
