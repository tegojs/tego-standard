import { defineCollection } from '@tego/server';

export default defineCollection({
  name: 'cloudLibraries',
  dumpRules: 'required',
  logging: true,
  autoGenId: true,
  createdAt: true,
  createdBy: true,
  updatedAt: true,
  updatedBy: true,
  fields: [
    {
      name: 'name',
      type: 'string',
      unique: true,
    },
    {
      name: 'code',
      type: 'text',
      allowNull: false,
      defaultValue: '',
    },
    {
      name: 'codeSource',
      type: 'string',
      defaultValue: 'local',
      // local: 本地代码, remote: 远程代码
    },
    {
      name: 'codeType',
      type: 'string',
      // cdn: CDN 地址, git: Git 仓库地址（由前端指定，后端不判断）
    },
    {
      name: 'codeUrl',
      type: 'string',
      // 远程代码地址: CDN URL 或 Git 仓库地址
    },
    {
      name: 'codeBranch',
      type: 'string',
      defaultValue: 'main',
      // Git 分支名称，默认为 main
    },
    {
      name: 'codePath',
      type: 'string',
      // Git 仓库中的文件路径
    },
    {
      name: 'codeCache',
      type: 'jsonb',
      // 缓存远程代码内容和更新时间
    },
    {
      name: 'data',
      type: 'json',
      jsonb: false,
    },
    {
      name: 'description',
      type: 'text',
    },
    {
      name: 'enabled',
      type: 'boolean',
      defaultValue: false,
    },
    {
      name: 'isClient',
      type: 'boolean',
      defaultValue: false,
    },
    {
      name: 'isServer',
      type: 'boolean',
      defaultValue: false,
    },
    {
      name: 'module',
      type: 'string',
      allowNull: false,
      unique: true,
    },
    {
      name: 'serverPlugin',
      type: 'string',
    },
    {
      name: 'clientPlugin',
      type: 'string',
    },
    {
      name: 'component',
      type: 'string',
    },
    {
      name: 'version',
      type: 'string',
      defaultValue: 'debug',
    },
    {
      name: 'versions',
      type: 'jsonb',
      defaultValue: '[]',
    },
  ],
});
