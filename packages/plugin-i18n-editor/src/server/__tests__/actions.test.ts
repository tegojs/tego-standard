import { createMockServer, MockServer } from '@tachybase/test';
import Database, { Repository } from '@tego/server';

describe('actions', () => {
  describe('localizations', () => {
    let app: MockServer;
    let db: Database;
    let repo: Repository;
    let agent;
    let originalPluginList;

    const clear = async () => {
      await repo.destroy({
        truncate: true,
      });
      await db.getRepository('localizationTranslations').destroy({
        truncate: true,
      });
    };

    const withFailingPluginList = async (callback: () => Promise<void>) => {
      const originalList = app.pm.list;
      (app.pm as any).list = async () => {
        throw new Error('plugin list failed');
      };

      try {
        await callback();
      } finally {
        (app.pm as any).list = originalList;
      }
    };

    beforeAll(async () => {
      app = await createMockServer({
        plugins: ['localization-management'],
      });
      db = app.db;
      repo = db.getRepository('localizationTexts');
      agent = app.agent();
      originalPluginList = app.pm.list;
      (app.pm as any).list = async () => [];
    });

    afterAll(async () => {
      (app.pm as any).list = originalPluginList;
      await app.destroy();
    });

    describe('list', () => {
      beforeAll(async () => {
        await repo.create({
          values: [
            {
              module: 'test',
              text: 'text',
              translations: [
                {
                  locale: 'en-US',
                  translation: 'translation',
                },
              ],
            },
            {
              module: 'test',
              text: 'text1',
              translations: [
                {
                  locale: 'zh-CN',
                  translation: 'translation1',
                },
              ],
            },
          ],
        });
      });

      afterAll(async () => {
        await clear();
      });

      it('should list localization texts', async () => {
        const res = await agent.set('X-Locale', 'en-US').resource('localizationTexts').list();
        expect(res.body.data.length).toBe(2);
        expect(res.body.data[0].text).toBe('text');
        expect(res.body.data[0].translation).toBe('translation');
        expect(res.body.data[0].translationId).toBe(1);

        const res2 = await agent.set('X-Locale', 'zh-CN').resource('localizationTexts').list();
        expect(res2.body.data.length).toBe(2);
        expect(res2.body.data[0].text).toBe('text');
        expect(res2.body.data[0].translation).toBeUndefined();
      });

      it('should propagate plugin list errors when listing localization texts', async () => {
        await withFailingPluginList(async () => {
          const res = await agent.set('X-Locale', 'fr-FR').resource('localizationTexts').list();
          expect(res.statusCode).toBe(500);
        });
      });

      it('should propagate plugin list errors when getting a localization text', async () => {
        const text = await repo.findOne({
          filter: {
            text: 'text',
          },
        });

        await withFailingPluginList(async () => {
          const res = await agent
            .set('X-Locale', 'de-DE')
            .resource('localizationTexts')
            .get({
              filterByTk: text.get('id'),
            });
          expect(res.statusCode).toBe(500);
        });
      });

      it('should search by keyword', async () => {
        let res = await agent.set('X-Locale', 'zh-CN').resource('localizationTexts').list({
          keyword: 'text',
        });
        expect(res.body.data.length).toBe(2);

        res = await agent.set('X-Locale', 'en-US').resource('localizationTexts').list({
          keyword: 'translation',
        });
        expect(res.body.data.length).toBe(1);
      });

      it('should filter no translation', async () => {
        const res = await agent.set('X-Locale', 'zh-CN').resource('localizationTexts').list({
          keyword: 'text',
          hasTranslation: 'false',
        });
        expect(res.body.data.length).toBe(1);
        expect(res.body.data[0].text).toBe('text');
        expect(res.body.data[0].translation).toBeUndefined();
      });
    });
  });
});
