import { Action, Context, Controller, Next } from '@tego/server';

import dayjs from 'dayjs';
import xlsx from 'node-xlsx';

@Controller('reportGenerator')
export class ReportGeneratorController {
  @Action('generate', { acl: 'loggedIn' })
  async generateReport(ctx: Context, next: Next) {
    const { prompt, collectionName, filters, fields, format = 'xlsx' } = ctx.action.params.values || {};

    if (!prompt) {
      ctx.throw(400, '提示词不能为空');
    }

    try {
      // 如果没有指定集合名称，尝试从提示词中解析
      let targetCollection = collectionName;
      if (!targetCollection) {
        targetCollection = this.parseCollectionFromPrompt(prompt, ctx);
      }

      if (!targetCollection) {
        ctx.throw(400, '无法从提示词中识别数据集合，请明确指定集合名称');
      }

      // 获取数据集合
      const repository = ctx.db.getRepository(targetCollection);
      if (!repository) {
        ctx.throw(400, `数据集合 "${targetCollection}" 不存在`);
      }

      // 构建查询参数
      const queryParams: any = {
        context: ctx,
      };

      if (filters) {
        queryParams.filter = typeof filters === 'string' ? JSON.parse(filters) : filters;
      }

      if (fields && Array.isArray(fields)) {
        queryParams.fields = fields;
      }

      // 查询数据
      const data = await repository.find(queryParams);
      const count = await repository.count({
        filter: queryParams.filter,
        context: ctx,
      });

      // 生成报表
      let result;
      if (format === 'xlsx') {
        result = await this.generateExcelReport({
          data,
          collection: repository.collection,
          prompt,
          ctx,
        });
      } else {
        ctx.throw(400, `不支持的报表格式: ${format}`);
      }

      // 直接返回文件内容
      ctx.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${encodeURIComponent(result.filename)}"`,
      });
      ctx.body = result.buffer;

      await next();
    } catch (error) {
      ctx.throw(500, error.message || '生成报表失败');
    }
  }

  @Action('listCollections', { acl: 'loggedIn' })
  async listCollections(ctx: Context, next: Next) {
    try {
      const collections = ctx.db.collections;
      const collectionList = Array.from(collections.values())
        .filter((collection) => !collection.options.hidden)
        .map((collection) => ({
          name: collection.name,
          title: collection.options.title || collection.name,
          fields: Array.from(collection.fields.values()).map((field) => ({
            name: field.name,
            type: field.type,
            title: field.options?.uiSchema?.title || field.name,
          })),
        }));

      ctx.body = {
        success: true,
        data: collectionList,
      };

      await next();
    } catch (error) {
      ctx.throw(500, error.message || '获取数据集合列表失败');
    }
  }

  /**
   * 从提示词中解析数据集合名称
   */
  private parseCollectionFromPrompt(prompt: string, ctx: Context): string | null {
    const collections = ctx.db.collections;
    const collectionNames = Array.from(collections.keys());

    // 简单的关键词匹配
    const promptLower = prompt.toLowerCase();

    // 常见的数据集合关键词映射
    const keywords: Record<string, string[]> = {
      users: ['用户', 'user', '人员', '成员'],
      roles: ['角色', 'role', '权限'],
      collections: ['集合', 'collection', '数据表'],
      files: ['文件', 'file', '附件'],
    };

    // 首先尝试关键词匹配
    for (const [collectionName, keywordsList] of Object.entries(keywords)) {
      if (collectionNames.includes(collectionName)) {
        for (const keyword of keywordsList) {
          if (promptLower.includes(keyword)) {
            return collectionName;
          }
        }
      }
    }

    // 然后尝试直接匹配集合名称
    for (const collectionName of collectionNames) {
      if (promptLower.includes(collectionName.toLowerCase())) {
        return collectionName;
      }
    }

    return null;
  }

  /**
   * 生成Excel报表
   */
  private async generateExcelReport(options: {
    data: any[];
    collection: any;
    prompt: string;
    ctx: Context;
  }): Promise<{ filename: string; buffer: Buffer }> {
    const { data, collection, prompt } = options;

    // 如果没有数据，返回空报表
    if (!data || data.length === 0) {
      const emptyRows = [['暂无数据']];
      const stream = xlsx.build([
        {
          name: '报表',
          data: emptyRows,
        },
      ]);

      const fileName = `report_${dayjs().format('YYYYMMDDHHmmss')}.xlsx`;

      return {
        filename: fileName,
        buffer: Buffer.from(stream),
      };
    }

    // 获取字段信息
    const fields = Array.from(collection.fields.values()).filter(
      (field) => !field.options.hidden && field.name !== 'id',
    );

    // 构建表头
    const headers = [fields.map((field) => field.options?.uiSchema?.title || field.name)];

    // 构建数据行
    const rows = data.map((item) => {
      return fields.map((field) => {
        let value = item[field.name];

        // 处理日期类型
        if (value instanceof Date) {
          value = dayjs(value).format('YYYY-MM-DD HH:mm:ss');
        }

        // 处理对象类型（关联字段）
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          value = value.id || JSON.stringify(value);
        }

        // 处理数组类型
        if (Array.isArray(value)) {
          value = value.map((v) => (typeof v === 'object' ? v.id || JSON.stringify(v) : v)).join(', ');
        }

        // 处理布尔类型
        if (typeof value === 'boolean') {
          value = value ? '是' : '否';
        }

        // 处理null和undefined
        if (value === null || value === undefined) {
          value = '';
        }

        return value;
      });
    });

    // 添加提示词信息作为备注
    const allRows = [
      [
        ['报表生成时间', dayjs().format('YYYY-MM-DD HH:mm:ss')],
        ['提示词', prompt],
      ],
      [],
      ...headers,
      ...rows,
    ];

    const stream = xlsx.build([
      {
        name: '报表',
        data: allRows,
      },
    ]);

    const fileName = `report_${dayjs().format('YYYYMMDDHHmmss')}.xlsx`;

    return {
      filename: fileName,
      buffer: Buffer.from(stream),
    };
  }
}
