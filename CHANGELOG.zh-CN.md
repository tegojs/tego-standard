# 更新日志

本项目的所有重要变更都将记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.0.0/)，
并且本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]



## [1.6.0] - 2025-11-20

### ✨ 新增

- 在 event & perf(workflow) 之后调整资源操作的事件源代码：调整执行时间的工作流代码 ([#285](https://github.com/tegojs/tego-standard/pull/285)) (@bai.zixv)
- 添加备份进度和下载进度 & 杂务：游标规则更新 & 杂务：更新 github 工作流程 ([#280](https://github.com/tegojs/tego-standard/pull/280)) (@bai.zixv)
- 审批摘要支持数组类型数据 & feat: 更改工作流程和审批列表页面的列显示 ([#239](https://github.com/tegojs/tego-standard/pull/239)) (@bai.zixv)
- 添加光标挂钩以进行自动格式化和翻译同步([#282](https://github.com/tegojs/tego-standard/pull/282)) (@bai.zixv)

### 🐛 修复

- **workflow**: 修复同步审批工作流程 ([#284](https://github.com/tegojs/tego-standard/pull/284)) (@bai.zixv)
- **backup**: 修复备份进度超时检查 ([#283](https://github.com/tegojs/tego-standard/pull/283)) (@bai.zixv)
- **workflow-approval**: 测试逻辑 & 修复（工作流）：useAction 字符串引用 & 修复（工作流）：重复的工作流类别默认值 & 修复（数据源）：集合表列宽 & 杂项（光标）：更新 lint 检查规则 ([#279](https://github.com/tegojs/tego-standard/pull/279)) (@bai.zixv)
- 批准抄送详细信息 ([#269](https://github.com/tegojs/tego-standard/pull/269)) (@dududuna)
- 导出当前表函数并添加过滤条件([#271](https://github.com/tegojs/tego-standard/pull/271)) (@dududuna)
- 审批添加返回并更新审批导航路径 ([#265](https://github.com/tegojs/tego-standard/pull/265)) (@dududuna)

## [1.5.1] - 2025-11-13

### 🐛 修复

- 修复审批提醒和审批记录重复([#256](https://github.com/tegojs/tego-standard/pull/256)) (@bai.zixv)

### 🔄 变更

- **core**: 允许令牌中的空用户状态 ([#267](https://github.com/tegojs/tego-standard/pull/267)) (@bai.zixv)


## [1.5.0] - 2025-11-11

### ✨ 新增

- 显示应用程序版本哈希和链接，更改逻辑 (@bai.zixv)


## [1.4.0] - 2025-11-10

### ✨ 新增

- 添加事件源描述字段 ([#241](https://github.com/tegojs/tego-standard/pull/241)) (@dududuna)
- 备份常用数据 ([#240](https://github.com/tegojs/tego-standard/pull/240)) (@bai.zixv)
- **scripts&client&module-web**: 显示版本哈希和链接 ([#235](https://github.com/tegojs/tego-standard/pull/235)) (@TomyJan)
- 批准详细信息显示批准号([#223](https://github.com/tegojs/tego-standard/pull/223)) (@dududuna)
- **core&module-auth&module-user**: 用户状态([#213](https://github.com/tegojs/tego-standard/pull/213)) (@TomyJan)
- 添加事件源类别和工作流程描述 ([#218](https://github.com/tegojs/tego-standard/pull/218)) (@dududuna)
- **plugin-field-bank-card-number**: 银行卡号字段插件 ([#219](https://github.com/tegojs/tego-standard/pull/219)) (@TomyJan)
- 批准排序([#215](https://github.com/tegojs/tego-standard/pull/215)) (@dududuna)
- 表格分页 ([#137](https://github.com/tegojs/tego-standard/pull/137)) (@dududuna)
- 将 packageName 添加到插件管理器 ([#135](https://github.com/tegojs/tego-standard/pull/135)) (@bai.zixv)
- 选项卡添加可拖动 ([#111](https://github.com/tegojs/tego-standard/pull/111)) (@Winc159)
- 非本地存储 ([#51](https://github.com/tegojs/tego-standard/pull/51)) (@张琳 Lin Zhang)
- 添加表单编辑插件([#35](https://github.com/tegojs/tego-standard/pull/35)) (@bai.zixv)
- 拖动手柄页面选项卡 ([#24](https://github.com/tegojs/tego-standard/pull/24)) (@bai.zixv)

### 🐛 修复

- 表格列对齐不适用于数字 ([#247](https://github.com/tegojs/tego-standard/pull/247)) (@dududuna)
- rsbuild 配置 ([#246](https://github.com/tegojs/tego-standard/pull/246)) (@bai.zixv)
- 工作流画布溢出-x隐藏＆功能：添加点击到组件编辑器＆功能：添加执行结束消息＆测试空执行（＃236） (@bai.zixv)
- 更新审批流程分类、工作流程和事件源表字段 ([#232](https://github.com/tegojs/tego-standard/pull/232)) (@dududuna)
- 批准复制操作([#222](https://github.com/tegojs/tego-standard/pull/222)) (@bai.zixv)
- 工作流程审批，旧版本支持撤回([#211](https://github.com/tegojs/tego-standard/pull/211)) (@bai.zixv)
- 子表单([#210](https://github.com/tegojs/tego-standard/pull/210)) (@dududuna)
- 表格分页 ([#209](https://github.com/tegojs/tego-standard/pull/209)) (@dududuna)
- 表格分页 ([#203](https://github.com/tegojs/tego-standard/pull/203)) (@dududuna)
- 循环进度 ([#200](https://github.com/tegojs/tego-standard/pull/200)) (@dududuna)
- 移动共享 ([#153](https://github.com/tegojs/tego-standard/pull/153)) (@dududuna)
- 修复创建表单时缺少异步的问题 ([#129](https://github.com/tegojs/tego-standard/pull/129)) (@Winc159)
- 标题名称 ([#145](https://github.com/tegojs/tego-standard/pull/145)) (@dududuna)
- 修复计算结果 ([#144](https://github.com/tegojs/tego-standard/pull/144)) (@bai.zixv)
- 修复公式视图 ([#143](https://github.com/tegojs/tego-standard/pull/143)) (@bai.zixv)
- 云组件 ([#141](https://github.com/tegojs/tego-standard/pull/141)) (@dududuna)
- 分享页面 ([#139](https://github.com/tegojs/tego-standard/pull/139)) (@dududuna)
- 表关联过滤([#102](https://github.com/tegojs/tego-standard/pull/102)) (@dududuna)
- 表单设计0813 ([#86](https://github.com/tegojs/tego-standard/pull/86)) (@Winc159)
- 修复了用户手册插件命名空间和 acl ([#63](https://github.com/tegojs/tego-standard/pull/63)) (@bai.zixv)
- 声明模块应该是@tego/server ([#50](https://github.com/tegojs/tego-standard/pull/50)) (@张琳 Lin Zhang)
- pdfjs Worker src 更改为 pdf.worker.min.mjs ([#48](https://github.com/tegojs/tego-standard/pull/48)) (@张琳 Lin Zhang)
- 验证码 (@Toby)
- 多应用合作伙伴登录 (@Toby)
- 评估器 mathjs 无法启用 (@sealday)
- 升级到最新的tego (@sealday)
- tbu 和 tbi (@sealday)
- 数学插件 (@sealday)
- 客户端版本不匹配 (@sealday)
- 版本不匹配 (@sealday)

### 🔄 变更

- 直接导入 lodash 和 dayjs，而不是通过 @tego/client 和 @tego/server ([#49](https://github.com/tegojs/tego-standard/pull/49)) (@张琳 Lin Zhang)
- 使用 @tego/server 和 @tego/client ([#15](https://github.com/tegojs/tego-standard/pull/15)) (@张琳 Lin Zhang)
- 删除核心库 (@sealday)
- 备份类别 ([#231](https://github.com/tegojs/tego-standard/pull/231)) (@TomyJan)
- 支持公式界面中的 `bankCard` 字段类型 ([#224](https://github.com/tegojs/tego-standard/pull/224)) (@TomyJan)
- **table-v2**: 行/列双向分批激活，降低首帧与首次更新开销 ([#180](https://github.com/tegojs/tego-standard/pull/180)) (@bai.zixv)


## [1.3.27] - 2025-07-28

### 🔄 变更

- **core**: 删除旧的预设包逻辑，现在通过 env 定义插件 ([#735](https://github.com/tegojs/tego-standard/pull/735)) (@张琳 Lin Zhang)
- mv 应用程序到包 ([#734](https://github.com/tegojs/tego-standard/pull/734)) (@张琳 Lin Zhang)

### 📝 文档

- 更新自述文件 (@sealday)


## [1.3.26] - 2025-07-27

### ✨ 新增

- 支持开发安装传递argv (@sealday)

### 🐛 修复

- 开发模式安装和升级 ([#731](https://github.com/tegojs/tego-standard/pull/731)) (@张琳 Lin Zhang)
- 开发命令 (@sealday)
- 评估者客户导出评估 ([#730](https://github.com/tegojs/tego-standard/pull/730)) (@张琳 Lin Zhang)
- 泰戈路径 (@sealday)

### 🔄 变更

- 删除插件 (@sealday)


## [1.3.25] - 2025-09-02

### ✨ 新增

- 选项卡添加可拖动 ([#111](https://github.com/tegojs/tego-standard/pull/111)) (@Winc159)

### 🐛 修复

- 表关联过滤([#102](https://github.com/tegojs/tego-standard/pull/102)) (@dududuna)
- 表单设计0813 ([#86](https://github.com/tegojs/tego-standard/pull/86)) (@Winc159)
- 修复了用户手册插件命名空间和 acl ([#63](https://github.com/tegojs/tego-standard/pull/63)) (@bai.zixv)


## [1.3.24] - 2025-08-04

### ✨ 新增

- 非本地存储 ([#51](https://github.com/tegojs/tego-standard/pull/51)) (@张琳 Lin Zhang)

### 🐛 修复

- 声明模块应该是@tego/server ([#50](https://github.com/tegojs/tego-standard/pull/50)) (@张琳 Lin Zhang)


## [1.3.23] - 2025-08-03

### ✨ 新增

- 添加表单编辑插件([#35](https://github.com/tegojs/tego-standard/pull/35)) (@bai.zixv)
- 拖动手柄页面选项卡 ([#24](https://github.com/tegojs/tego-standard/pull/24)) (@bai.zixv)

### 🐛 修复

- pdfjs Worker src 更改为 pdf.worker.min.mjs ([#48](https://github.com/tegojs/tego-standard/pull/48)) (@张琳 Lin Zhang)

### 🔄 变更

- 直接导入 lodash 和 dayjs，而不是通过 @tego/client 和 @tego/server ([#49](https://github.com/tegojs/tego-standard/pull/49)) (@张琳 Lin Zhang)


## [1.3.22] - 2025-07-29

### ✨ 新增

- 添加飞书用户手册插件([#728](https://github.com/tegojs/tego-standard/pull/728)) (@bai.zixv)

### 🐛 修复

- 验证码 (@Toby)
- 多应用合作伙伴登录 (@Toby)
- 评估器 mathjs 无法启用 (@sealday)
- 升级到最新的tego (@sealday)
- tbu 和 tbi (@sealday)
- 数学插件 (@sealday)
- 客户端版本不匹配 (@sealday)
- 版本不匹配 (@sealday)
- 主题编辑器演示污染 ([#729](https://github.com/tegojs/tego-standard/pull/729)) (@Winc159)

### 🔄 变更

- 使用 @tego/server 和 @tego/client ([#15](https://github.com/tegojs/tego-standard/pull/15)) (@张琳 Lin Zhang)
- 删除核心库 (@sealday)


## [1.3.21] - 2025-07-25

### 🐛 修复

- 修复审批流程标签颜色并删除未使用的代码 ([#695](https://github.com/tegojs/tego-standard/pull/695)) (@bai.zixv)
- 查询表中关联字段时出错 ([#696](https://github.com/tegojs/tego-standard/pull/696)) (@dududuna)
- 迁移共享功能 ([#655](https://github.com/tegojs/tego-standard/pull/655)) (@dududuna)
- 改进自定义标题 ([#602](https://github.com/tegojs/tego-standard/pull/602)) (@dududuna)


## [1.3.20] - 2025-07-24

### ✨ 新增

- 确切日期 (@wildworker)
- smschangepwd ([#702](https://github.com/tegojs/tego-standard/pull/702)) (@wildworker)
- antd 移动选择 ([#699](https://github.com/tegojs/tego-standard/pull/699)) (@bai.zixv)
- 主应用程序登录 ([#681](https://github.com/tegojs/tego-standard/pull/681)) (@wildworker)

### 🐛 修复

- 夜间条目 ([#714](https://github.com/tegojs/tego-standard/pull/714)) (@wildworker)
- 夜间图像 ([#708](https://github.com/tegojs/tego-standard/pull/708)) (@wildworker)
- 重复添加记录器流 ([#700](https://github.com/tegojs/tego-standard/pull/700)) (@wildworker)


## [1.3.19] - 2025-07-17

### ✨ 新增

- 主应用程序登录 ([#639](https://github.com/tegojs/tego-standard/pull/639)) (@wildworker)

### 🐛 修复

- **devkit**: 确保构建失败并退出并显示代码 1 (@sealday)


## [1.3.18] - 2025-07-17

### ✨ 新增

- 动态页面 ([#506](https://github.com/tegojs/tego-standard/pull/506)) (@bai.zixv)
- 优化移动选择 ([#638](https://github.com/tegojs/tego-standard/pull/638)) (@bai.zixv)

### 🐛 修复

- **core**: 确保单个 i18next 实例在核心和插件之间共享 (@sealday)
- **core**: 确保单个 i18next 实例在核心和插件之间共享 (@sealday)
- **deps**: i18next 版本并恢复 @react-pdf/render 版本 ([#669](https://github.com/tegojs/tego-standard/pull/669)) (@张琳 Lin Zhang)
- 自动启动未定义 ([#663](https://github.com/tegojs/tego-standard/pull/663)) (@wildworker)
- 重置密码为空 ([#613](https://github.com/tegojs/tego-standard/pull/613)) (@wildworker)
- 国际化编辑器 ([#631](https://github.com/tegojs/tego-standard/pull/631)) (@bai.zixv)

### 🔄 变更

- 子应用程序自启动后升级子应用程序 ([#608](https://github.com/tegojs/tego-standard/pull/608)) (@wildworker)


## [1.3.17] - 2025-07-04

### 🐛 修复

- 修复 auth-sms 命名空间 ([#604](https://github.com/tegojs/tego-standard/pull/604)) (@bai.zixv)
- 夜间图像 ([#601](https://github.com/tegojs/tego-standard/pull/601)) (@wildworker)


## [1.3.16] - 2025-07-02

### 🐛 修复

- **core**: 加载预设插件失败 (@sealday)


## [1.3.15] - 2025-07-01

### 🐛 修复

- 基础镜像 ([#598](https://github.com/tegojs/tego-standard/pull/598)) (@wildworker)


## [1.3.14] - 2025-07-01

### 🐛 修复

- tego-node-pg ([#596](https://github.com/tegojs/tego-standard/pull/596)) (@wildworker)
- dockerfile tego ([#594](https://github.com/tegojs/tego-standard/pull/594)) (@wildworker)
- docker compose 示例将 tachybase 更改为 tego (@sealday)


## [1.3.13] - 2025-06-30

### 🐛 修复

- tego 命令错误 ([#584](https://github.com/tegojs/tego-standard/pull/584)) (@张琳 Lin Zhang)

### 📝 文档

- 将 tachybase 重命名为 tego ([#583](https://github.com/tegojs/tego-standard/pull/583)) (@张琳 Lin Zhang)


## [1.3.12] - 2025-06-30

### 🐛 修复

- 固定移动选择组件([#576](https://github.com/tegojs/tego-standard/pull/576)) (@bai.zixv)
- 移动日期选择器占位符 ([#571](https://github.com/tegojs/tego-standard/pull/571)) (@bai.zixv)
- 固定表分页([#581](https://github.com/tegojs/tego-standard/pull/581)) (@bai.zixv)
- 带表前缀的树结构过滤器 ([#574](https://github.com/tegojs/tego-standard/pull/574)) (@Winc159)

### 🔄 变更

- 开发套件 ([#561](https://github.com/tegojs/tego-standard/pull/561)) (@张琳 Lin Zhang)


## [1.3.11] - 2025-06-27

### 🐛 修复

- 数据库 mysql col ([#572](https://github.com/tegojs/tego-standard/pull/572)) (@wildworker)
- 删除 plugin-list.md 的备份 ([#564](https://github.com/tegojs/tego-standard/pull/564)) (@bai.zixv)


## [1.3.10] - 2025-06-26

### ✨ 新增

- 更改欢迎卡路由器 ([#560](https://github.com/tegojs/tego-standard/pull/560)) (@bai.zixv)

### 🐛 修复

- **full-text-search**: 续集山口 ([#562](https://github.com/tegojs/tego-standard/pull/562)) (@wildworker)
- 工作线程工作脚本路径 ([#563](https://github.com/tegojs/tego-standard/pull/563)) (@wildworker)


## [1.3.8] - 2025-06-25

### 🐛 修复

- docker路径错误 (@sealday)


## [1.3.7] - 2025-06-24

### 🔄 变更

- 更改为 ts ([#551](https://github.com/tegojs/tego-standard/pull/551)) (@张琳 Lin Zhang)


## [1.3.6] - 2025-06-24

### 🐛 修复

- 工作线程未使用最新的加载器实现 ([#550](https://github.com/tegojs/tego-standard/pull/550)) (@张琳 Lin Zhang)


## [1.3.5] - 2025-06-24

### 🐛 修复

- 建造 (@sealday)


## [1.3.4] - 2025-06-24

### 🐛 修复

- 不允许从 esm 要求 cjs (@sealday)


## [1.3.2] - 2025-06-24

### 🐛 修复

- 个别回购开发引发错误 ([#548](https://github.com/tegojs/tego-standard/pull/548)) (@张琳 Lin Zhang)


## [1.3.1] - 2025-06-24

### 🐛 修复

- docker 构建引擎 ([#547](https://github.com/tegojs/tego-standard/pull/547)) (@张琳 Lin Zhang)


## [1.3.0] - 2025-06-24

### ✨ 新增

- tachybase 全局变量并添加多路径支持 ([#519](https://github.com/tegojs/tego-standard/pull/519)) (@张琳 Lin Zhang)

### 🐛 修复

- 空包中的 pnpm dev ([#546](https://github.com/tegojs/tego-standard/pull/546)) (@张琳 Lin Zhang)
- 预设引擎错误 ([#544](https://github.com/tegojs/tego-standard/pull/544)) (@张琳 Lin Zhang)
- 导入集合错误 ([#541](https://github.com/tegojs/tego-standard/pull/541)) (@张琳 Lin Zhang)
- 多应用共享集合插件无法加载 ([#540](https://github.com/tegojs/tego-standard/pull/540)) (@张琳 Lin Zhang)
- **client**: 缺少 xlsx dep ([#533](https://github.com/tegojs/tego-standard/pull/533)) (@张琳 Lin Zhang)
- **server**: 加载插件路径错误 (@sealday)

### 🔄 变更

- 将默认预设从服务器移动到引擎 ([#543](https://github.com/tegojs/tego-standard/pull/543)) (@张琳 Lin Zhang)
- 将插件移动到存储插件 ([#542](https://github.com/tegojs/tego-standard/pull/542)) (@张琳 Lin Zhang)


## [1.2.15] - 2025-06-23

### ✨ 新增

- 将调试日志添加到sync-plugin-list-to-docs-repo.yml ([#520](https://github.com/tegojs/tego-standard/pull/520)) (@bai.zixv)

### 🐛 修复

- 初始化插件复制文本 ([#523](https://github.com/tegojs/tego-standard/pull/523)) (@wildworker)
- 更新sync-plugin-list-to-docs-repo.yml ([#526](https://github.com/tegojs/tego-standard/pull/526)) (@bai.zixv)
- 更新sync-plugin-list-to-docs-repo.yml ([#525](https://github.com/tegojs/tego-standard/pull/525)) (@bai.zixv)
- 更新sync-plugin-list-to-docs-repo.yml ([#524](https://github.com/tegojs/tego-standard/pull/524)) (@bai.zixv)
- 更新sync-plugin-list-to-docs-repo.yml ([#522](https://github.com/tegojs/tego-standard/pull/522)) (@bai.zixv)
- 更新sync-plugin-list-to-docs-repo.yml ([#521](https://github.com/tegojs/tego-standard/pull/521)) (@bai.zixv)


## [1.2.14] - 2025-06-23

### ✨ 新增

- 默认运行引擎并添加一些测试 ([#518](https://github.com/tegojs/tego-standard/pull/518)) (@张琳 Lin Zhang)


## [1.2.13] - 2025-06-21

### 🐛 修复

- 找不到复制文本 ([#517](https://github.com/tegojs/tego-standard/pull/517)) (@张琳 Lin Zhang)


## [1.2.12] - 2025-06-21

### 🐛 修复

- 备份插件检查所有并添加文本复制插件([#515](https://github.com/tegojs/tego-standard/pull/515)) (@bai.zixv)
- **auth**: updateOrCreate filterKeys 错误 ([#514](https://github.com/tegojs/tego-standard/pull/514)) (@wildworker)

### 🔄 变更

- 优化引擎参数，重构引擎加载逻辑并更新readme ([#508](https://github.com/tegojs/tego-standard/pull/508)) (@张琳 Lin Zhang)


## [1.2.11] - 2025-06-19

### ✨ 新增

- 添加密码策略、到期日期和修复：修复文档标题 ([#504](https://github.com/tegojs/tego-standard/pull/504)) (@bai.zixv)

### 🐛 修复

- （auth）令牌突然过期([#507](https://github.com/tegojs/tego-standard/pull/507)) (@wildworker)
- 表不存在时迁移 ([#505](https://github.com/tegojs/tego-standard/pull/505)) (@wildworker)


## [1.2.10] - 2025-06-19

### 🐛 修复

- 速基团队 (@sealday)


## [1.2.8] - 2025-06-19

### 🐛 修复

- 从没有 SERVE PATH 开始也可以 ([#501](https://github.com/tegojs/tego-standard/pull/501)) (@张琳 Lin Zhang)


## [1.2.7] - 2025-06-19

### ✨ 新增

- 引擎现在可以准备插件了([#500](https://github.com/tegojs/tego-standard/pull/500)) (@张琳 Lin Zhang)
- 仪器优化 ([#499](https://github.com/tegojs/tego-standard/pull/499)) (@张琳 Lin Zhang)
- 仪器优化 ([#424](https://github.com/tegojs/tego-standard/pull/424)) (@Winc159)

### 🐛 修复

- pnpm-lock.yaml (@sealday)
- 批准创建([#497](https://github.com/tegojs/tego-standard/pull/497)) (@bai.zixv)
- 多应用停止按钮 ([#496](https://github.com/tegojs/tego-standard/pull/496)) (@wildworker)
- 批准复制状态 ([#445](https://github.com/tegojs/tego-standard/pull/445)) (@dududuna)

### 🔄 变更

- 工作流程批准 ([#462](https://github.com/tegojs/tego-standard/pull/462)) (@bai.zixv)


## [1.2.6] - 2025-06-18

### 🐛 修复

- 当预设为空时设置 PluginPresets ([#491](https://github.com/tegojs/tego-standard/pull/491)) (@wildworker)
- win路径连接错误 (@sealday)


## [1.2.5] - 2025-06-18

### 🐛 修复

- **core**: multer 版本不匹配 ([#490](https://github.com/tegojs/tego-standard/pull/490)) (@张琳 Lin Zhang)


## [1.2.3] - 2025-06-17

### 🐛 修复

- docker-engine 路径 ([#489](https://github.com/tegojs/tego-standard/pull/489)) (@张琳 Lin Zhang)


## [1.2.0] - 2025-06-17

### 🐛 修复

- 工作目录 (@sealday)


## [1.1.33] - 2025-06-17

### 🐛 修复

- 加载命令错误 (@sealday)


## [1.1.30] - 2025-06-17

### ✨ 新增

- 支持文本复制 ([#479](https://github.com/tegojs/tego-standard/pull/479)) (@bai.zixv)
- 备份模块支持检查所有项目 ([#482](https://github.com/tegojs/tego-standard/pull/482)) (@bai.zixv)
- 支持更多引擎拱 ([#487](https://github.com/tegojs/tego-standard/pull/487)) (@张琳 Lin Zhang)

### 🐛 修复

- 多应用程序预设 ([#484](https://github.com/tegojs/tego-standard/pull/484)) (@wildworker)


## [1.1.29] - 2025-06-17

### 🐛 修复

- 标签名称 ([#485](https://github.com/tegojs/tego-standard/pull/485)) (@张琳 Lin Zhang)


## [1.1.24] - 2025-06-17

### 🐛 修复

- 引擎猜测错误的路径 ([#481](https://github.com/tegojs/tego-standard/pull/481)) (@张琳 Lin Zhang)


## [1.1.23] - 2025-06-17

### 🐛 修复

- 发动机负载 ([#480](https://github.com/tegojs/tego-standard/pull/480)) (@张琳 Lin Zhang)
- 事件源实时刷新 ([#478](https://github.com/tegojs/tego-standard/pull/478)) (@wildworker)


## [1.1.22] - 2025-06-17

### ✨ 新增

- 使用项目名称初始化 ([#477](https://github.com/tegojs/tego-standard/pull/477)) (@张琳 Lin Zhang)


## [1.1.21] - 2025-06-17

### 🐛 修复

- 构建类型错误 ([#463](https://github.com/tegojs/tego-standard/pull/463)) (@bai.zixv)


## [1.1.20] - 2025-06-17

### ✨ 新增

- 在工作区脚本中添加引擎启动 ([#468](https://github.com/tegojs/tego-standard/pull/468)) (@张琳 Lin Zhang)


## [1.1.17] - 2025-06-17

### 🐛 修复

- 工作人员在引擎模式下工作并修复 oxlint 规则 ([#466](https://github.com/tegojs/tego-standard/pull/466)) (@张琳 Lin Zhang)


## [1.1.16] - 2025-06-16

### ✨ 新增

- tachybase 引擎泊坞窗 ([#464](https://github.com/tegojs/tego-standard/pull/464)) (@张琳 Lin Zhang)

### 🐛 修复

- tachybase-engine docker 名称 (@sealday)


## [1.1.15] - 2025-06-16

### 🐛 修复

- npx 中的 lru 和负载迁移 (@sealday)


## [1.1.14] - 2025-06-16

### 🐛 修复

- pnpm-lock.yaml (@sealday)


## [1.1.13] - 2025-06-16

### 🐛 修复

- 全球版本已修复 (@sealday)


## [1.1.12] - 2025-06-16

### 🐛 修复

- 引擎应该依赖react-dom (@sealday)


## [1.1.11] - 2025-06-16

### 🐛 修复

- 服务器部门 (@sealday)


## [1.1.10] - 2025-06-16

### 🐛 修复

- 发动机仓 ([#456](https://github.com/tegojs/tego-standard/pull/456)) (@张琳 Lin Zhang)


## [1.1.9] - 2025-06-16

### ✨ 新增

- 使用自定义插件支持 init (@sealday)

### 🐛 修复

- cli 默认加载 env.e2e.example (@sealday)
- 发动机类型错误 (@sealday)
- 引擎客户端路径 (@sealday)


## [1.1.8] - 2025-06-16

### 🐛 修复

- pnpm 工作区 (@sealday)


## [1.1.7] - 2025-06-16

### 🔄 变更

- 删除预设包并重命名 app-rs ([#455](https://github.com/tegojs/tego-standard/pull/455)) (@张琳 Lin Zhang)


## [1.1.6] - 2025-06-13

### 🐛 修复

- 取消选择表后组块数据不正确 ([#454](https://github.com/tegojs/tego-standard/pull/454)) (@dududuna)
- 同步消息错误 ([#452](https://github.com/tegojs/tego-standard/pull/452)) (@wildworker)
- 组表过滤器 ([#450](https://github.com/tegojs/tego-standard/pull/450)) (@dududuna)
- 取消选择表后组块数据不正确 ([#396](https://github.com/tegojs/tego-standard/pull/396)) (@dududuna)


## [1.1.5] - 2025-06-11

### ✨ 新增

- 支持自定义请求操作中的外部请求 ([#449](https://github.com/tegojs/tego-standard/pull/449)) (@bai.zixv)

### 🐛 修复

- 引擎窗口文件路径 ([#443](https://github.com/tegojs/tego-standard/pull/443)) (@wildworker)


## [1.1.4] - 2025-06-09

### 🐛 修复

- 当表单项描述为空时隐藏额外内容 ([#444](https://github.com/tegojs/tego-standard/pull/444)) (@Winc159)
- SDK axios 版本 ([#442](https://github.com/tegojs/tego-standard/pull/442)) (@wildworker)
- axios 适用于客户端/服务器和引擎模式 (@sealday)

### 🔄 变更

- pkg 加载到内存中 ([#448](https://github.com/tegojs/tego-standard/pull/448)) (@张琳 Lin Zhang)


## [1.1.3] - 2025-05-26

### 🐛 修复

- axios 错误 ([#441](https://github.com/tegojs/tego-standard/pull/441)) (@wildworker)


## [1.1.2] - 2025-05-23

### 🐛 修复

- **backup**: 删除自动备份密码 ([#439](https://github.com/tegojs/tego-standard/pull/439)) (@wildworker)
- 数学版本 (@sealday)


## [1.1.1] - 2025-05-23

### 🐛 修复

- app-rs 分区 (@sealday)


## [1.1.0] - 2025-05-23

### 🐛 修复

- 适配器红色节点插件 ([#438](https://github.com/tegojs/tego-standard/pull/438)) (@张琳 Lin Zhang)
- ocr 转换构建 ([#437](https://github.com/tegojs/tego-standard/pull/437)) (@张琳 Lin Zhang)

### 📝 文档

- 更新自述文件 (@sealday)


## [1.0.25] - 2025-05-21

### 🐛 修复

- 滑块 ([#436](https://github.com/tegojs/tego-standard/pull/436)) (@dududuna)


## [1.0.23] - 2025-05-20

### ✨ 新增

- 创建脚本并编辑包 ([#428](https://github.com/tegojs/tego-standard/pull/428)) (@Winc159)
- 对引擎模式的初步支持 ([#430](https://github.com/tegojs/tego-standard/pull/430)) (@张琳 Lin Zhang)
- 添加数字滑块 ([#425](https://github.com/tegojs/tego-standard/pull/425)) (@dududuna)
- 添加分享 ([#431](https://github.com/tegojs/tego-standard/pull/431)) (@dududuna)
- 自动备份 ([#420](https://github.com/tegojs/tego-standard/pull/420)) (@wildworker)
- 将工作流程测试更改为 codemirror 组件 ([#427](https://github.com/tegojs/tego-standard/pull/427)) (@Winc159)

### 🐛 修复

- 滑块 ([#433](https://github.com/tegojs/tego-standard/pull/433)) (@dududuna)
- 离开服务器客户端 ACL 不匹配 ([#432](https://github.com/tegojs/tego-standard/pull/432)) (@wildworker)

### 🔄 变更

- 工作流程类别 ([#423](https://github.com/tegojs/tego-standard/pull/423)) (@Winc159)


## [1.0.22] - 2025-04-25

### ✨ 新增

- 重构仪器 ([#415](https://github.com/tegojs/tego-standard/pull/415)) (@Winc159)


## [1.0.20] - 2025-04-25

### ✨ 新增

- 在数字字段中添加前缀和后缀 ([#421](https://github.com/tegojs/tego-standard/pull/421)) (@Winc159)
- 添加重新图表 ([#412](https://github.com/tegojs/tego-standard/pull/412)) (@dududuna)

### 🐛 修复

- pnpm 安装错误 ([#422](https://github.com/tegojs/tego-standard/pull/422)) (@wildworker)


## [1.0.19] - 2025-04-23

### ✨ 新增

- 步骤形式([#419](https://github.com/tegojs/tego-standard/pull/419)) (@bai.zixv)
- 多应用操作 ([#414](https://github.com/tegojs/tego-standard/pull/414)) (@dududuna)

### 🐛 修复

- 批准图标颜色 ([#416](https://github.com/tegojs/tego-standard/pull/416)) (@dududuna)
- 核心包签名错误 ([#417](https://github.com/tegojs/tego-standard/pull/417)) (@wildworker)


## [1.0.18] - 2025-04-18

### 🐛 修复

- 工作流程审批，FuzzySearch id 为 isInteger ([#411](https://github.com/tegojs/tego-standard/pull/411)) (@bai.zixv)


## [1.0.17] - 2025-04-18

### ✨ 新增

- 多应用显示及加法操作([#408](https://github.com/tegojs/tego-standard/pull/408)) (@dududuna)


## [1.0.16] - 2025-04-17

### 🐛 修复

- pnpm 构建错误 ([#410](https://github.com/tegojs/tego-standard/pull/410)) (@wildworker)


## [1.0.15] - 2025-04-15

### ✨ 新增

- 短信验证同意 ([#406](https://github.com/tegojs/tego-standard/pull/406)) (@wildworker)

### 🐛 修复

- http 字段 int 允许 float 类型 ([#407](https://github.com/tegojs/tego-standard/pull/407)) (@wildworker)


## [1.0.14] - 2025-04-14

### 🐛 修复

- dbviews acl ([#405](https://github.com/tegojs/tego-standard/pull/405)) (@wildworker)
- 子应用在线用户错误 ([#404](https://github.com/tegojs/tego-standard/pull/404)) (@wildworker)


## [1.0.13] - 2025-04-11

### 🐛 修复

- 拼写错误 ([#401](https://github.com/tegojs/tego-standard/pull/401)) (@wildworker)
- 子应用程序相同的应用程序密钥 ([#400](https://github.com/tegojs/tego-standard/pull/400)) (@wildworker)

### 🔄 变更

- 在线用户活动中心([#402](https://github.com/tegojs/tego-standard/pull/402)) (@wildworker)
- 插件手动通知增强 ([#399](https://github.com/tegojs/tego-standard/pull/399)) (@wildworker)


## [1.0.12] - 2025-04-09

### ✨ 新增

- 在线用户和客户端数量 ([#398](https://github.com/tegojs/tego-standard/pull/398)) (@wildworker)
- 插件 ocr 转换 ([#393](https://github.com/tegojs/tego-standard/pull/393)) (@wildworker)

### 🐛 修复

- 翻译，修复 zh 语言支持 ([#394](https://github.com/tegojs/tego-standard/pull/394)) (@bai.zixv)
- 迁移错误、创建 sql 函数错误、api-keys 中间件错误 ([#392](https://github.com/tegojs/tego-standard/pull/392)) (@wildworker)

### 🔄 变更

- 多应用程序展示 ([#397](https://github.com/tegojs/tego-standard/pull/397)) (@wildworker)


## [1.0.11] - 2025-04-03

### 🐛 修复

- api-keys 迁移错误 ([#391](https://github.com/tegojs/tego-standard/pull/391)) (@wildworker)


## [1.0.10] - 2025-04-03

### 🐛 修复

- 可以更改 http 集合中的主键或唯一键 ([#387](https://github.com/tegojs/tego-standard/pull/387)) (@wildworker)
- 令牌长度超过 255 ([#389](https://github.com/tegojs/tego-standard/pull/389)) (@wildworker)
- 子应用循环 ([#386](https://github.com/tegojs/tego-standard/pull/386)) (@wildworker)
- 预留者工作流程触发器 ([#384](https://github.com/tegojs/tego-standard/pull/384)) (@wildworker)

### 🔄 变更

- 备份下载逻辑，错误显示([#390](https://github.com/tegojs/tego-standard/pull/390)) (@wildworker)


## [1.0.9] - 2025-04-03

### 🔄 变更

- 更好的日志，更好的子应用程序表 ([#383](https://github.com/tegojs/tego-standard/pull/383)) (@wildworker)


## [1.0.8] - 2025-04-03

### 🔄 变更

- 当昵称为空时显示用户 ([#382](https://github.com/tegojs/tego-standard/pull/382)) (@wildworker)


## [1.0.7] - 2025-04-02

### ✨ 新增

- 系统更新消息通知 ([#375](https://github.com/tegojs/tego-standard/pull/375)) (@Winc159)
- iframe、CodeMirror ([#380](https://github.com/tegojs/tego-standard/pull/380)) (@bai.zixv)

### 🐛 修复

- 备份子应用程序工作者应用程序名称错误 ([#379](https://github.com/tegojs/tego-standard/pull/379)) (@wildworker)

### 🔄 变更

- 子应用程序 ([#381](https://github.com/tegojs/tego-standard/pull/381)) (@wildworker)


## [1.0.6] - 2025-04-01

### 🐛 修复

- 定义主要 ([#378](https://github.com/tegojs/tego-standard/pull/378)) (@wildworker)


## [1.0.5] - 2025-04-01

### 🐛 修复

- 是开放的 ([#377](https://github.com/tegojs/tego-standard/pull/377)) (@wildworker)


## [1.0.4] - 2025-04-01

### ✨ 新增

- 子应用程序 cname 验证器 ([#373](https://github.com/tegojs/tego-standard/pull/373)) (@wildworker)

### 🐛 修复

- 更改已运行的应用程序 ([#366](https://github.com/tegojs/tego-standard/pull/366)) (@Winc159)
- $dateBetween 错误 ([#368](https://github.com/tegojs/tego-standard/pull/368)) (@wildworker)
- 备份单个文件路径 ([#372](https://github.com/tegojs/tego-standard/pull/372)) (@wildworker)


## [1.0.3] - 2025-03-31

### ✨ 新增

- 删除多个应用程序翻译 ([#371](https://github.com/tegojs/tego-standard/pull/371)) (@bai.zixv)


## [1.0.2] - 2025-03-31

### 🐛 修复

- 多应用 ACL 错误 ([#370](https://github.com/tegojs/tego-standard/pull/370)) (@wildworker)


## [1.0.1] - 2025-03-31

### ✨ 新增

- 验证、翻译 ([#369](https://github.com/tegojs/tego-standard/pull/369)) (@bai.zixv)
- 限制工人数量([#346](https://github.com/tegojs/tego-standard/pull/346)) (@wildworker)
- 登录、翻译 ([#348](https://github.com/tegojs/tego-standard/pull/348)) (@bai.zixv)
- 添加了表格对齐方法([#351](https://github.com/tegojs/tego-standard/pull/351)) (@dududuna)
- 页面、选项卡、拖动 ([#354](https://github.com/tegojs/tego-standard/pull/354)) (@bai.zixv)
- 滚动区域，将默认值更改为隐藏 ([#357](https://github.com/tegojs/tego-standard/pull/357)) (@bai.zixv)

### 🐛 修复

- 子选项卡 secondarylevel 选择链接 ([#364](https://github.com/tegojs/tego-standard/pull/364)) (@Winc159)


## [1.0.0] - 2025-03-27

### 🐛 修复

- 更新自述文件 ([#363](https://github.com/tegojs/tego-standard/pull/363)) (@wildworker)


## [0.23.66] - 2025-03-27

### ✨ 新增

- 添加多应用程序块，更改样式 ([#335](https://github.com/tegojs/tego-standard/pull/335)) (@bai.zixv)
- 令牌政策([#331](https://github.com/tegojs/tego-standard/pull/331)) (@wildworker)
- **auth-login**: 支持新风格的登录页面 ([#308](https://github.com/tegojs/tego-standard/pull/308)) (@bai.zixv)
- 安全密码策略 ([#323](https://github.com/tegojs/tego-standard/pull/323)) (@wildworker)
- 工作流节点、转储和上传 ([#328](https://github.com/tegojs/tego-standard/pull/328)) (@Winc159)
- 向条件添加存在性检查 ([#312](https://github.com/tegojs/tego-standard/pull/312)) (@Winc159)
- 向组件添加自定义类型 ([#305](https://github.com/tegojs/tego-standard/pull/305)) (@dududuna)

### 🐛 修复

- 动作名称 ([#361](https://github.com/tegojs/tego-standard/pull/361)) (@wildworker)
- RolesUsers 主键错误 ([#359](https://github.com/tegojs/tego-standard/pull/359)) (@wildworker)
- 无法查看内部消息 ([#350](https://github.com/tegojs/tego-standard/pull/350)) (@dududuna)
- env 秘密使用错误 ([#356](https://github.com/tegojs/tego-standard/pull/356)) (@wildworker)
- 创建摘要卡时出错 ([#353](https://github.com/tegojs/tego-standard/pull/353)) (@dududuna)
- 数据源集合字段 acl 错误 ([#355](https://github.com/tegojs/tego-standard/pull/355)) (@wildworker)
- 数据源集合 acl 错误 ([#352](https://github.com/tegojs/tego-standard/pull/352)) (@wildworker)
- 工作流程列表 acl 登录 ([#349](https://github.com/tegojs/tego-standard/pull/349)) (@wildworker)
- 取消过滤表后数据不正确([#347](https://github.com/tegojs/tego-standard/pull/347)) (@dududuna)
- 格式代码 (@Toby)
- 语言环境错误 (@Toby)
- 干净的代码 (@Toby)
- 区域设置、用户锁定策略 (@Toby)
- 不同的语言环境，主应用程序和子应用程序之间的角色（＃340） (@wildworker)
- 注册时的密码强度 ([#338](https://github.com/tegojs/tego-standard/pull/338)) (@wildworker)
- 内部消息不能使用参考模板 ([#337](https://github.com/tegojs/tego-standard/pull/337)) (@dududuna)
- ci 开发 ([#329](https://github.com/tegojs/tego-standard/pull/329)) ([#336](https://github.com/tegojs/tego-standard/pull/336)) (@wildworker)
- http 显示 baseURL，显示 HTTP ([#334](https://github.com/tegojs/tego-standard/pull/334)) (@wildworker)
- 表，排序问题 ([#333](https://github.com/tegojs/tego-standard/pull/333)) (@Winc159)
- 默认值尚未删除 ([#332](https://github.com/tegojs/tego-standard/pull/332)) (@dududuna)
- 联动规则更新不刷新问题 ([#330](https://github.com/tegojs/tego-standard/pull/330)) (@Winc159)
- 表单没有默认值选择 ([#324](https://github.com/tegojs/tego-standard/pull/324)) (@dududuna)
- groupBlock 的过滤条件不正确 ([#326](https://github.com/tegojs/tego-standard/pull/326)) (@dududuna)
- acl 数据源：列表 acl 错误 ([#322](https://github.com/tegojs/tego-standard/pull/322)) (@wildworker)
- 草稿状态的审批处理时间 ([#314](https://github.com/tegojs/tego-standard/pull/314)) (@dududuna)
- 审批流程时间线 ([#309](https://github.com/tegojs/tego-standard/pull/309)) (@bai.zixv)


## [0.23.65] - 2025-03-20

### 🐛 修复

- 开发中的 CI ([#329](https://github.com/tegojs/tego-standard/pull/329)) (@wildworker)


## [0.23.64] - 2025-03-13

### 🐛 修复

- 数据源错误 ([#316](https://github.com/tegojs/tego-standard/pull/316)) (@wildworker)


## [0.23.63] - 2025-03-13

### 🐛 修复

- **collection**: 集合错误 ([#315](https://github.com/tegojs/tego-standard/pull/315)) (@wildworker)


## [0.23.62] - 2025-03-13

### 🐛 修复

- 关联表 acl 错误 ([#313](https://github.com/tegojs/tego-standard/pull/313)) (@wildworker)


## [0.23.61] - 2025-03-13

### ✨ 新增

- 在提交成功之前绑定工作 ([#298](https://github.com/tegojs/tego-standard/pull/298)) (@wildworker)

### 🐛 修复

- 在审批处理期间显示审批列表 ([#304](https://github.com/tegojs/tego-standard/pull/304)) (@dududuna)
- 限制操作 ACL ([#294](https://github.com/tegojs/tego-standard/pull/294)) (@wildworker)
- groupBlock 迁移到图表插件 ([#302](https://github.com/tegojs/tego-standard/pull/302)) (@dududuna)


## [0.23.60] - 2025-03-07

### 🐛 修复

- 批准，草案应触发工作流程，创建执行记录([#300](https://github.com/tegojs/tego-standard/pull/300)) (@bai.zixv)


## [0.23.59] - 2025-03-06

### 🐛 修复

- 审批移动、工作流程密钥 ([#299](https://github.com/tegojs/tego-standard/pull/299)) (@bai.zixv)


## [0.23.58] - 2025-03-06

### ✨ 新增

- 工作流，为所有工作流节点添加备注字段 ([#293](https://github.com/tegojs/tego-standard/pull/293)) (@bai.zixv)

### 🐛 修复

- 应用程序表错误，中间件错误([#296](https://github.com/tegojs/tego-standard/pull/296)) (@wildworker)
- env-secrets 内置，升级时 api-logs 错误 ([#297](https://github.com/tegojs/tego-standard/pull/297)) (@wildworker)
- 复制按钮设置栏样式 ([#292](https://github.com/tegojs/tego-standard/pull/292)) (@dududuna)


## [0.23.57] - 2025-03-05

### 🐛 修复

- 关联表中没有查询数据 ([#295](https://github.com/tegojs/tego-standard/pull/295)) (@dududuna)
- 单击单选按钮没有清除它([#291](https://github.com/tegojs/tego-standard/pull/291)) (@dududuna)


## [0.23.56] - 2025-03-04

### ✨ 新增

- 页面、选项卡、设置 ([#282](https://github.com/tegojs/tego-standard/pull/282)) (@bai.zixv)

### 🐛 修复

- 重置将覆盖数据范围([#289](https://github.com/tegojs/tego-standard/pull/289)) (@dududuna)
- 重复表单过滤条件 ([#287](https://github.com/tegojs/tego-standard/pull/287)) (@dududuna)
- addBelongsToManyThrough 过滤器 null ([#290](https://github.com/tegojs/tego-standard/pull/290)) (@wildworker)
- 全文搜索类型错误 ([#288](https://github.com/tegojs/tego-standard/pull/288)) (@wildworker)
- 通过（＃283）聚合belongsToMany (@wildworker)

### 🔄 变更

- 显示备份下载百分比 ([#285](https://github.com/tegojs/tego-standard/pull/285)) (@wildworker)


## [0.23.55] - 2025-02-28

### 🐛 修复

- 批准，initAt ([#280](https://github.com/tegojs/tego-standard/pull/280)) (@bai.zixv)


## [0.23.54] - 2025-02-27

### 🐛 修复

- 循环导入([#279](https://github.com/tegojs/tego-standard/pull/279)) (@wildworker)


## [0.23.53] - 2025-02-27

### 🐛 修复

- 代码错误 ([#278](https://github.com/tegojs/tego-standard/pull/278)) (@wildworker)


## [0.23.52] - 2025-02-27

### 🐛 修复

- postgre 日期、数字错误 ([#277](https://github.com/tegojs/tego-standard/pull/277)) (@wildworker)
- 添加后自定义请求不显示 ([#276](https://github.com/tegojs/tego-standard/pull/276)) (@wildworker)


## [0.23.51] - 2025-02-27

### ✨ 新增

- 页面、选项卡 ([#273](https://github.com/tegojs/tego-standard/pull/273)) (@bai.zixv)

### 🐛 修复

- 模态，内部滚动 ([#275](https://github.com/tegojs/tego-standard/pull/275)) (@bai.zixv)
- 自定义请求设置environmentVariables null ([#274](https://github.com/tegojs/tego-standard/pull/274)) (@wildworker)


## [0.23.50] - 2025-02-27

### ✨ 新增

- 事件源和工作流程，修改表格的呈现方式 ([#265](https://github.com/tegojs/tego-standard/pull/265)) (@bai.zixv)
- 插件环境秘密 ([#248](https://github.com/tegojs/tego-standard/pull/248)) (@wildworker)
- 翻译 ([#262](https://github.com/tegojs/tego-standard/pull/262)) (@bai.zixv)

### 🐛 修复

- 中间件中缺少 return next() ([#268](https://github.com/tegojs/tego-standard/pull/268)) (@wildworker)
- 事件源错误报告 ([#264](https://github.com/tegojs/tego-standard/pull/264)) (@wildworker)
- 自定义请求([#253](https://github.com/tegojs/tego-standard/pull/253)) (@wildworker)
- api 日志错误 ([#266](https://github.com/tegojs/tego-standard/pull/266)) (@wildworker)
- 过滤和排序之间的冲突问题 ([#263](https://github.com/tegojs/tego-standard/pull/263)) (@dududuna)

### 🔄 变更

- 页面组件([#270](https://github.com/tegojs/tego-standard/pull/270)) (@bai.zixv)
- 角色检查错误重定向到登录 ([#267](https://github.com/tegojs/tego-standard/pull/267)) (@wildworker)


## [0.23.49] - 2025-02-21

### 🐛 修复

- 一些 bug api 日志、tmpl 密码 ([#261](https://github.com/tegojs/tego-standard/pull/261)) (@wildworker)


## [0.23.48] - 2025-02-21

### ✨ 新增

- 框图、兼容性错误和翻译 ([#258](https://github.com/tegojs/tego-standard/pull/258)) (@bai.zixv)

### 🐛 修复

- 创建 tachybase 错误 ([#257](https://github.com/tegojs/tego-standard/pull/257)) (@wildworker)
- 事件源triggerOnAssociation 错误 ([#260](https://github.com/tegojs/tego-standard/pull/260)) (@wildworker)
- 按顺序添加主键时出错 ([#259](https://github.com/tegojs/tego-standard/pull/259)) (@wildworker)
- 删除效果库 ([#249](https://github.com/tegojs/tego-standard/pull/249)) (@Winc159)


## [0.23.47] - 2025-02-20

### 🐛 修复

- 内部消息上下文丢失 ([#255](https://github.com/tegojs/tego-standard/pull/255)) (@dududuna)
- 移动设备、DatePicker、validDate 和批准、移动设备、状态 ([#256](https://github.com/tegojs/tego-standard/pull/256)) (@bai.zixv)


## [0.23.46] - 2025-02-20

### ✨ 新增

- 批准，移动 ([#251](https://github.com/tegojs/tego-standard/pull/251)) (@bai.zixv)
- 新插件 api 日志 ([#246](https://github.com/tegojs/tego-standard/pull/246)) (@Winc159)

### 🐛 修复

- 工作流程密钥未在移动设备中发送([#254](https://github.com/tegojs/tego-standard/pull/254)) (@wildworker)
- 排序字段不包含在组中 ([#250](https://github.com/tegojs/tego-standard/pull/250)) (@wildworker)
- 自定义工作流触发器显示抛出错误 ([#245](https://github.com/tegojs/tego-standard/pull/245)) (@wildworker)
- http 收集错误 ([#244](https://github.com/tegojs/tego-standard/pull/244)) (@wildworker)

### 🔄 变更

- 将正式代码迁移到模式([#247](https://github.com/tegojs/tego-standard/pull/247)) (@张琳 Lin Zhang)
- 事件源 ([#214](https://github.com/tegojs/tego-standard/pull/214)) (@wildworker)


## [0.23.45] - 2025-02-13

### ✨ 新增

- 工作流审批添加重试和执行时间 ([#236](https://github.com/tegojs/tego-standard/pull/236)) (@Winc159)

### 🐛 修复

- http 集合 acl ([#242](https://github.com/tegojs/tego-standard/pull/242)) (@wildworker)
- 数据库事件将事务发送到工作流程 ([#243](https://github.com/tegojs/tego-standard/pull/243)) (@wildworker)


## [0.23.44] - 2025-02-13

### 🐛 修复

- **message**: 修复消息短信错误 ([#237](https://github.com/tegojs/tego-standard/pull/237)) (@bai.zixv)
- 子应用程序获取 swagger 未设置标头主机名 ([#241](https://github.com/tegojs/tego-standard/pull/241)) (@wildworker)
- 子域子应用程序无法获取 websocket 消息 ([#240](https://github.com/tegojs/tego-standard/pull/240)) (@wildworker)
- 提示消息未正确结束或关闭 ([#239](https://github.com/tegojs/tego-standard/pull/239)) (@dududuna)


## [0.23.43] - 2025-02-11

### 🐛 修复

- 核心包构建错误 ([#235](https://github.com/tegojs/tego-standard/pull/235)) (@wildworker)


## [0.23.42] - 2025-02-11

### ✨ 新增

- 执行添加重试功能 ([#228](https://github.com/tegojs/tego-standard/pull/228)) (@Winc159)
- 添加自定义标签到阅读模式 ([#220](https://github.com/tegojs/tego-standard/pull/220)) (@dududuna)
- 支持移动工作流程 ([#217](https://github.com/tegojs/tego-standard/pull/217)) (@wildworker)
- 工作流分析工具 ([#222](https://github.com/tegojs/tego-standard/pull/222)) (@Winc159)

### 🐛 修复

- React-i18next 导致重试函数错误 ([#234](https://github.com/tegojs/tego-standard/pull/234)) (@Winc159)
- 提示消息未正确结束或关闭 ([#231](https://github.com/tegojs/tego-standard/pull/231)) (@dududuna)
- 过滤块，保存上一个合并过滤器 (@dududuna)
- 替换非分页查询参数 ([#230](https://github.com/tegojs/tego-standard/pull/230)) (@dududuna)
- 替换非分页查询参数 ([#229](https://github.com/tegojs/tego-standard/pull/229)) (@dududuna)
- 其余 api baseUrl 不显示 ([#225](https://github.com/tegojs/tego-standard/pull/225)) (@wildworker)
- 找不到 postgres 搜索列 ([#223](https://github.com/tegojs/tego-standard/pull/223)) (@wildworker)
- tb 拼写错误 ([#221](https://github.com/tegojs/tego-standard/pull/221)) (@张琳 Lin Zhang)
- **client**: 调试工具现在可以获取最新的架构 ([#219](https://github.com/tegojs/tego-standard/pull/219)) (@张琳 Lin Zhang)
- **module-users**: 无法修改角色 ([#218](https://github.com/tegojs/tego-standard/pull/218)) (@张琳 Lin Zhang)

### 🔄 变更

- 自定义事件源和工作流程批准 ([#224](https://github.com/tegojs/tego-standard/pull/224)) (@bai.zixv)


## [0.23.41] - 2025-01-22

### ✨ 新增

- 菜单，样式颜色 ([#211](https://github.com/tegojs/tego-standard/pull/211)) (@bai.zixv)
- 菜单、子菜单、样式 ([#209](https://github.com/tegojs/tego-standard/pull/209)) (@bai.zixv)

### 🐛 修复

- 将 TabPaneInitialize 替换为 Popup：addTab ([#216](https://github.com/tegojs/tego-standard/pull/216)) (@dududuna)
- 批准，修复表单([#208](https://github.com/tegojs/tego-standard/pull/208)) (@bai.zixv)
- 添加块来改进标签 ([#210](https://github.com/tegojs/tego-standard/pull/210)) (@dududuna)
- cron 关闭不起作用，事件关闭 ([#212](https://github.com/tegojs/tego-standard/pull/212)) (@wildworker)
- 摘要图表设置隐藏分类字段 ([#205](https://github.com/tegojs/tego-standard/pull/205)) (@dududuna)
- 找不到 dataSources.role ([#206](https://github.com/tegojs/tego-standard/pull/206)) (@wildworker)

### 🔄 变更

- 全文搜索，支持枚举（单个或多个）([#207](https://github.com/tegojs/tego-standard/pull/207)) (@wildworker)


## [0.23.40] - 2025-01-19

### ✨ 新增

- 图表表现在可以按列排序并修复组表冗余类别字段([#204](https://github.com/tegojs/tego-standard/pull/204)) (@张琳 Lin Zhang)
- **charts**: 接地表 ([#201](https://github.com/tegojs/tego-standard/pull/201)) (@bai.zixv)
- 菜单，菜单添加按钮([#197](https://github.com/tegojs/tego-standard/pull/197)) (@bai.zixv)
- 支持关联上的资源操作触发器 ([#202](https://github.com/tegojs/tego-standard/pull/202)) (@张琳 Lin Zhang)

### 🐛 修复

- 组表配置错误和修复样式 ([#203](https://github.com/tegojs/tego-standard/pull/203)) (@张琳 Lin Zhang)


## [0.23.39] - 2025-01-17

### 🐛 修复

- 工作流程、更新或创建附件 ([#200](https://github.com/tegojs/tego-standard/pull/200)) (@bai.zixv)
- 无法注册 ([#195](https://github.com/tegojs/tego-standard/pull/195)) (@wildworker)

### 🔄 变更

- 右下快捷工具应该是系统机制([#199](https://github.com/tegojs/tego-standard/pull/199)) (@张琳 Lin Zhang)


## [0.23.38] - 2025-01-16

### ✨ 新增

- 菜单、搜索样式和侧边栏添加菜单样式和模糊搜索删除更改搜索([#194](https://github.com/tegojs/tego-standard/pull/194)) (@bai.zixv)


## [0.23.37] - 2025-01-16

### 🐛 修复

- 清除 ui 架构缓存 ([#192](https://github.com/tegojs/tego-standard/pull/192)) (@wildworker)


## [0.23.36] - 2025-01-16

### ✨ 新增

- 菜单、搜索 ([#191](https://github.com/tegojs/tego-standard/pull/191)) (@bai.zixv)
- 多应用程序支持 startAll 和 stopAll ([#190](https://github.com/tegojs/tego-standard/pull/190)) (@wildworker)


## [0.23.35] - 2025-01-16

### ✨ 新增

- 菜单、在 AdminMenu 中搜索和上传 ([#186](https://github.com/tegojs/tego-standard/pull/186)) (@bai.zixv)
- 为数据查询节点添加无分页选项 ([#185](https://github.com/tegojs/tego-standard/pull/185)) (@Winc159)
- 菜单，管理菜单 ([#184](https://github.com/tegojs/tego-standard/pull/184)) (@bai.zixv)
- 按“belongTo”或“hasOne”字段排序([#180](https://github.com/tegojs/tego-standard/pull/180)) (@wildworker)
- 更新CSS样式修复换行问题并添加提示词([#179](https://github.com/tegojs/tego-standard/pull/179)) (@Winc159)
- 菜单，可拖动 ([#178](https://github.com/tegojs/tego-standard/pull/178)) (@bai.zixv)
- 工作流程、更新和创建、附件、文件名 ([#177](https://github.com/tegojs/tego-standard/pull/177)) (@bai.zixv)

### 🐛 修复

- 开发插件找不到不允许运行 ([#188](https://github.com/tegojs/tego-standard/pull/188)) (@wildworker)
- 同步模式应该在错误时拦截([#187](https://github.com/tegojs/tego-standard/pull/187)) (@张琳 Lin Zhang)
- 解决区块评论无法更新的问题([#183](https://github.com/tegojs/tego-standard/pull/183)) (@Winc159)
- 选择 iosWeek 转换错误 ([#176](https://github.com/tegojs/tego-standard/pull/176)) (@wildworker)
- redisClient.connect() 多次 ([#174](https://github.com/tegojs/tego-standard/pull/174)) (@wildworker)

### 🔄 变更

- **client**: 优化菜单切换打开状态性能 ([#182](https://github.com/tegojs/tego-standard/pull/182)) (@张琳 Lin Zhang)
- 记录并取消订阅 ([#175](https://github.com/tegojs/tego-standard/pull/175)) (@wildworker)


## [0.23.34] - 2025-01-11

### 🐛 修复

- 日期范围 null 发送到服务器 ([#173](https://github.com/tegojs/tego-standard/pull/173)) (@wildworker)


## [0.23.33] - 2025-01-11

### 🐛 修复

- 审核日志在使用消息时创建，而不是插入时间 ([#172](https://github.com/tegojs/tego-standard/pull/172)) (@wildworker)
- 允许 dateRange 重置为 null ([#171](https://github.com/tegojs/tego-standard/pull/171)) (@wildworker)


## [0.23.32] - 2025-01-11

### 🐛 修复

- 审核日志批量、自定义请求错误 ([#170](https://github.com/tegojs/tego-standard/pull/170)) (@wildworker)


## [0.23.30] - 2025-01-10

### 🐛 修复

- **cloud-component**: 由于服务器上的云组件加载无序，导致某些模块无法找到([#169](https://github.com/tegojs/tego-standard/pull/169)) (@张琳 Lin Zhang)


## [0.23.29] - 2025-01-10

### 🐛 修复

- 导入菜单错误、自定义请求来源、测试工作流程、某些 process.env.NODE_ENV ([#167](https://github.com/tegojs/tego-standard/pull/167)) (@wildworker)
- 图表分组表字段计算 ([#165](https://github.com/tegojs/tego-standard/pull/165)) (@dududuna)
- 关联字段，正常形式情况 ([#168](https://github.com/tegojs/tego-standard/pull/168)) (@bai.zixv)
- 模糊搜索操作键 ([#164](https://github.com/tegojs/tego-standard/pull/164)) (@bai.zixv)

### 🔄 变更

- 用户数据源将表迁移到 tablev2 ([#166](https://github.com/tegojs/tego-standard/pull/166)) (@Winc159)
- 将用户表迁移到表 v2 ([#157](https://github.com/tegojs/tego-standard/pull/157)) (@Winc159)


## [0.23.28] - 2025-01-09

### 🐛 修复

- 自定义请求不能忽略主机 ([#162](https://github.com/tegojs/tego-standard/pull/162)) (@wildworker)
- cron 语言环境缓存为空 ([#161](https://github.com/tegojs/tego-standard/pull/161)) (@wildworker)


## [0.23.27] - 2025-01-09

### ✨ 新增

- 关联字段，createEditFormBlockUISchema ([#159](https://github.com/tegojs/tego-standard/pull/159)) (@bai.zixv)

### 🐛 修复

- 批准，创建表单时确认([#160](https://github.com/tegojs/tego-standard/pull/160)) (@bai.zixv)

### 🔄 变更

- 批准代码 ([#144](https://github.com/tegojs/tego-standard/pull/144)) (@bai.zixv)


## [0.23.26] - 2025-01-09

### ✨ 新增

- 添加与多对多表和 pdf 视图层次结构的关联 ([#156](https://github.com/tegojs/tego-standard/pull/156)) (@dududuna)
- 菜单、设置、更改设置设计模式 ([#155](https://github.com/tegojs/tego-standard/pull/155)) (@bai.zixv)
- 设置布局，支持标题上的管理位置 ([#153](https://github.com/tegojs/tego-standard/pull/153)) (@bai.zixv)

### 🐛 修复

- 全文搜索文字相同字段错误 ([#158](https://github.com/tegojs/tego-standard/pull/158)) (@wildworker)
- 应用程序事件 afterStart 多次触发 ([#154](https://github.com/tegojs/tego-standard/pull/154)) (@wildworker)
- 恢复超过长度限制的备份 ([#152](https://github.com/tegojs/tego-standard/pull/152)) (@wildworker)


## [0.23.25] - 2025-01-08

### ✨ 新增

- 模糊搜索注释 ([#151](https://github.com/tegojs/tego-standard/pull/151)) (@bai.zixv)
- 模糊搜索输入 ([#150](https://github.com/tegojs/tego-standard/pull/150)) (@bai.zixv)
- 所有字段模糊搜索 ([#117](https://github.com/tegojs/tego-standard/pull/117)) (@wildworker)
- notificationprovider 将表迁移到 tablev2 ([#138](https://github.com/tegojs/tego-standard/pull/138)) (@Winc159)
- 支持选择字段组件 ([#139](https://github.com/tegojs/tego-standard/pull/139)) (@bai.zixv)
- otp 将表迁移到 tablev2 ([#135](https://github.com/tegojs/tego-standard/pull/135)) (@Winc159)
- 验证器将表迁移到 tablev2 ([#141](https://github.com/tegojs/tego-standard/pull/141)) (@Winc159)
- 多应用程序将表迁移到 tablev2 ([#127](https://github.com/tegojs/tego-standard/pull/127)) (@Winc159)

### 🐛 修复

- 工作流触发工作流，上下文丢失 ([#149](https://github.com/tegojs/tego-standard/pull/149)) (@wildworker)
- 图表分类表允许选择分类字段([#145](https://github.com/tegojs/tego-standard/pull/145)) (@dududuna)
- 过滤表单并单击配置字段，导致错误 ([#147](https://github.com/tegojs/tego-standard/pull/147)) (@dududuna)
- db 事件 afterUpdate 触发四次 ([#134](https://github.com/tegojs/tego-standard/pull/134)) (@wildworker)
- 记录表单块中的模板关联字段 ([#143](https://github.com/tegojs/tego-standard/pull/143)) (@bai.zixv)
- allowedNewMenu 有时不起作用 ([#142](https://github.com/tegojs/tego-standard/pull/142)) (@wildworker)
- 备份按钮对于正常工作线程帮助文本显示更好 ([#126](https://github.com/tegojs/tego-standard/pull/126)) (@wildworker)
- 选项卡样式 ([#128](https://github.com/tegojs/tego-standard/pull/128)) (@bai.zixv)

### 🔄 变更

- 本地化将表迁移到表 v2 ([#146](https://github.com/tegojs/tego-standard/pull/146)) (@Winc159)


## [0.23.23] - 2025-01-02

### ✨ 新增

- 打开模式错误 ([#132](https://github.com/tegojs/tego-standard/pull/132)) (@bai.zixv)
- 滚动区域去抖 ([#131](https://github.com/tegojs/tego-standard/pull/131)) (@bai.zixv)
- pdf 样式 ([#129](https://github.com/tegojs/tego-standard/pull/129)) (@bai.zixv)
- 显示工作流中节点的 ID ([#125](https://github.com/tegojs/tego-standard/pull/125)) (@bai.zixv)
- 翻译 ([#122](https://github.com/tegojs/tego-standard/pull/122)) (@bai.zixv)
- 助理按钮插件并与固定列表一起使用 ([#118](https://github.com/tegojs/tego-standard/pull/118)) (@Winc159)
- 添加执行过滤器([#119](https://github.com/tegojs/tego-standard/pull/119)) (@bai.zixv)

### 🐛 修复

- 侧面布局溢出 ([#130](https://github.com/tegojs/tego-standard/pull/130)) (@bai.zixv)
- 工作方法首先重新加载集合。 (@wildworker)
- 事务提交后审计日志使用异步 ([#116](https://github.com/tegojs/tego-standard/pull/116)) (@wildworker)
- 批准，草稿不应触发工作流程 ([#121](https://github.com/tegojs/tego-standard/pull/121)) (@bai.zixv)
- 关闭抽屉前确认，批准([#120](https://github.com/tegojs/tego-standard/pull/120)) (@bai.zixv)

### 🔄 变更

- 将审批插件更改为新结构([#99](https://github.com/tegojs/tego-standard/pull/99)) (@bai.zixv)


## [0.23.22] - 2024-12-30

### 🐛 修复

- **field-sequence**: tval 滥用 (@sealday)


## [0.23.21] - 2024-12-30

### ✨ 新增

- **client**: 限制过滤项初始值设定项级别 (@sealday)

### 🐛 修复

- **field-sequence**: 日期格式无法配置 (@sealday)
- 添加一个按钮备份来显式判断它是否是worker ([#114](https://github.com/tegojs/tego-standard/pull/114)) (@wildworker)


## [0.23.20] - 2024-12-29

### ✨ 新增

- **web**: 数据选择 v1 ([#112](https://github.com/tegojs/tego-standard/pull/112)) (@DYC-zhanglin)

### 🐛 修复

- 回滚 axios 导致组块请求错误 ([#113](https://github.com/tegojs/tego-standard/pull/113)) (@DYC-zhanglin)
- Rest api 数据源设置字段错误，setHeader etag 错误 ([#111](https://github.com/tegojs/tego-standard/pull/111)) (@wildworker)

### 🔄 变更

- 清理 tsconfig.json ([#109](https://github.com/tegojs/tego-standard/pull/109)) (@DYC-zhanglin)


## [0.23.18] - 2024-12-26

### ✨ 新增

- 人工智能组件和卡片化([#94](https://github.com/tegojs/tego-standard/pull/94)) (@Winc159)

### 🐛 修复

- **client**: 修复 ssr 中的本地存储 ([#107](https://github.com/tegojs/tego-standard/pull/107)) (@DYC-zhanglin)


## [0.23.17] - 2024-12-26

### 🐛 修复

- 缺少开发工具 (@sealday)


## [0.23.16] - 2024-12-26

### 🐛 修复

- pnpm 锁 (@sealday)


## [0.23.15] - 2024-12-26

### 🐛 修复

- 创建 tachybase 应用程序 ([#106](https://github.com/tegojs/tego-standard/pull/106)) (@DYC-zhanglin)
- 升级后禁用插件 ([#105](https://github.com/tegojs/tego-standard/pull/105)) (@wildworker)


## [0.23.11] - 2024-12-26

### 🐛 修复

- 没有 git 检查 ([#103](https://github.com/tegojs/tego-standard/pull/103)) (@DYC-zhanglin)


## [0.23.10] - 2024-12-26

### 🐛 修复

- 部门 ([#102](https://github.com/tegojs/tego-standard/pull/102)) (@DYC-zhanglin)


## [0.23.9] - 2024-12-26

### ✨ 新增

- 支持数据源rest api ([#97](https://github.com/tegojs/tego-standard/pull/97)) (@wildworker)
- 添加功能列表块([#92](https://github.com/tegojs/tego-standard/pull/92)) (@bai.zixv)
- getLang http返回304,减少请求时间 ([#96](https://github.com/tegojs/tego-standard/pull/96)) (@wildworker)
- 在批准中添加提醒操作([#91](https://github.com/tegojs/tego-standard/pull/91)) (@bai.zixv)

### 🐛 修复

- 命令([#95](https://github.com/tegojs/tego-standard/pull/95)) (@DYC-zhanglin)
- 其余 api 数据源不显示 ([#101](https://github.com/tegojs/tego-standard/pull/101)) (@wildworker)
- 新添加的插件的启用状态不起作用 ([#100](https://github.com/tegojs/tego-standard/pull/100)) (@DYC-zhanglin)
- ViewTableMessagesWrapper 中的记忆模式并重新组织 module-message 中的组件结构 ([#98](https://github.com/tegojs/tego-standard/pull/98)) (@bai.zixv)


## [0.23.8] - 2024-12-23

### 🐛 修复

- 添加私有到演示 (@sealday)
- 重命名赫拉的名字 ([#87](https://github.com/tegojs/tego-standard/pull/87)) (@DYC-zhanglin)

### 🔄 变更

- 删除turborepo ([#88](https://github.com/tegojs/tego-standard/pull/88)) (@DYC-zhanglin)


## [0.23.7] - 2024-12-21

### ✨ 新增

- 支持工作人员备份 ([#64](https://github.com/tegojs/tego-standard/pull/64)) (@wildworker)

### 🐛 修复

- 主应用程序停止子应用程序，无法通过视图启动([#84](https://github.com/tegojs/tego-standard/pull/84)) (@wildworker)


## [0.23.5] - 2024-12-20

### 🐛 修复

- cron 作业模型错误，工作线程 writeRolesToACL 使用其他存储库 ([#80](https://github.com/tegojs/tego-standard/pull/80)) (@wildworker)


## [0.23.4] - 2024-12-20

### 🐛 修复

- 迁移工作流程错误 ([#79](https://github.com/tegojs/tego-standard/pull/79)) (@wildworker)


## [0.23.3] - 2024-12-20

### ✨ 新增

- 隐藏或显示上下文菜单的滚动区域逻辑 ([#72](https://github.com/tegojs/tego-standard/pull/72)) (@bai.zixv)
- 开发人员可以等待服务器 ([#73](https://github.com/tegojs/tego-standard/pull/73)) (@DYC-zhanglin)

### 🐛 修复

- 构建 tsup ([#69](https://github.com/tegojs/tego-standard/pull/69)) (@DYC-zhanglin)


## [0.23.2] - 2024-12-20

### 🐛 修复

- 延迟加载 ([#67](https://github.com/tegojs/tego-standard/pull/67)) (@DYC-zhanglin)


## [0.23.1] - 2024-12-20

### 🐛 修复

- 码头工人图像 ([#65](https://github.com/tegojs/tego-standard/pull/65)) (@DYC-zhanglin)


## [0.23.0] - 2024-12-20

### 🐛 修复

- cron 作业表 (@sealday)
- bigint 迁移 ([#62](https://github.com/tegojs/tego-standard/pull/62)) (@wildworker)
- 语言环境、db bigint 安全 ([#60](https://github.com/tegojs/tego-standard/pull/60)) (@wildworker)

### 🔄 变更

- 迁移到 rsbuild ([#63](https://github.com/tegojs/tego-standard/pull/63)) (@DYC-zhanglin)
- 将插件文件管理器移至模块文件 ([#61](https://github.com/tegojs/tego-standard/pull/61)) (@DYC-zhanglin)


## [0.22.85] - 2024-12-19

### ✨ 新增

- 在工作流代码镜像中添加当前表单变量并在消息中添加 messageVariables ([#58](https://github.com/tegojs/tego-standard/pull/58)) (@bai.zixv)
- 添加作业节点的执行时间 ([#55](https://github.com/tegojs/tego-standard/pull/55)) (@Winc159)
- **message**: 消息短信逻辑 ([#54](https://github.com/tegojs/tego-standard/pull/54)) (@bai.zixv)
- 初始化 rsbuild 支持 ([#50](https://github.com/tegojs/tego-standard/pull/50)) (@DYC-zhanglin)
- **workflow**: 处理已弃用的节点以使它们更容易找到([#46](https://github.com/tegojs/tego-standard/pull/46)) (@bai.zixv)
- **workflow**: 添加 ShowNodeTypesInWorkflow 组件以显示工作流中的节点类型 ([#44](https://github.com/tegojs/tego-standard/pull/44)) (@bai.zixv)
- 控制网络上的工作线程数、工作错误限制 ([#41](https://github.com/tegojs/tego-standard/pull/41)) (@wildworker)

### 🐛 修复

- 路由器错误 ([#57](https://github.com/tegojs/tego-standard/pull/57)) (@wildworker)
- 锁定文件 (@sealday)
- 数据源不显示 ([#53](https://github.com/tegojs/tego-standard/pull/53)) (@wildworker)
- 折叠面板创建树表错误 ([#51](https://github.com/tegojs/tego-standard/pull/51)) #40 (@dududuna)
- 将插件名称验证更改为 otp ([#52](https://github.com/tegojs/tego-standard/pull/52)) (@bai.zixv)
- cron 作业内存泄漏 ([#47](https://github.com/tegojs/tego-standard/pull/47)) (@wildworker)
- uiSchema 删除操作碰巧遇到 CRUD 操作 ([#45](https://github.com/tegojs/tego-standard/pull/45)) (@wildworker)
- 过滤文本的默认行为是 eq ([#43](https://github.com/tegojs/tego-standard/pull/43)) (@dududuna)
- **workflow**: 工作流程中多条历史记录不显示 & 修复(workflow): 与工作流程模块的兼容性问题 ([#42](https://github.com/tegojs/tego-standard/pull/42)) (@bai.zixv)

### 🔄 变更

- **messge**: 重构代码以使注册管理更容易([#49](https://github.com/tegojs/tego-standard/pull/49)) (@bai.zixv)


## [0.22.84] - 2024-12-18

### 🐛 修复

- 模块 cron 语言环境、cron 设置、使用执行日志 ([#36](https://github.com/tegojs/tego-standard/pull/36)) (@wildworker)

### 🔄 变更

- 工作流程支持标签 ([#37](https://github.com/tegojs/tego-standard/pull/37)) (@DYC-zhanglin)


## [0.22.83] - 2024-12-17

### ✨ 新增

- **devtools**: 初始化插件 ([#33](https://github.com/tegojs/tego-standard/pull/33)) (@Winc159)

### 🐛 修复

- 编辑器只读错误，worker 不支持 subApp ([#35](https://github.com/tegojs/tego-standard/pull/35)) (@wildworker)
- 不应出现在表中的默认值 ([#32](https://github.com/tegojs/tego-standard/pull/32)) (@dududuna)

### 🔄 变更

- 删除未使用的代码 ([#34](https://github.com/tegojs/tego-standard/pull/34)) (@bai.zixv)


## [0.22.82] - 2024-12-17

### 🐛 修复

- getPluginMethodKey 参数错误 ([#30](https://github.com/tegojs/tego-standard/pull/30)) (@wildworker)
- **client**: 调试模式编辑 ([#28](https://github.com/tegojs/tego-standard/pull/28)) (@DYC-zhanglin)

### 📝 文档

- 展示如何从旧版本升级 (@sealday)


## [0.22.81] - 2024-12-16

### 🐛 修复

- @tachybase/module-data-source-manager 构建错误和 i18n 问题 ([#27](https://github.com/tegojs/tego-standard/pull/27)) (@DYC-zhanglin)


## [0.22.75] - 2024-12-16

### ✨ 新增

- 支持 pg_client，图像中的 zip ([#1913](https://github.com/tegojs/tego-standard/pull/1913)) (@Toby)


## [0.22.72] - 2024-12-16

### ✨ 新增

- **client**: 优化调试体验 (@sealday)
- 工作微信使用手机作为唯一密钥 ([#1904](https://github.com/tegojs/tego-standard/pull/1904)) (@Toby)
- 在工作流程和站点消息中添加 WorkflowVariableCodeMirror 和其他修复 ([#1890](https://github.com/tegojs/tego-standard/pull/1890)) (@bai.zixv)
- toposort 支持独特选项 ([#1902](https://github.com/tegojs/tego-standard/pull/1902)) (@sealday)

### 🐛 修复

- 工作线程生产启动错误 ([#1909](https://github.com/tegojs/tego-standard/pull/1909)) (@Toby)
- 国际化 (@sealday)
- 工作线程 (@sealday)
- 管理设置布局跳转 ([#1903](https://github.com/tegojs/tego-standard/pull/1903)) (@sealday)
- 重复添加资源事件 ([#1900](https://github.com/tegojs/tego-standard/pull/1900)) (@sealday)
- 构建警告([#1899](https://github.com/tegojs/tego-standard/pull/1899)) (@sealday)

### 🔄 变更

- 模块网络 ([#1908](https://github.com/tegojs/tego-standard/pull/1908)) (@sealday)
- 重命名包([#1907](https://github.com/tegojs/tego-standard/pull/1907)) (@sealday)
- 统一@formily/x ([#1906](https://github.com/tegojs/tego-standard/pull/1906)) (@sealday)
- 审批 UI 和系统设置翻译 ([#1905](https://github.com/tegojs/tego-standard/pull/1905)) (@sealday)


## [0.22.69] - 2024-12-13

### ✨ 新增

- cron 作业插件使用工作流程，而不是触发器类型 ([#1883](https://github.com/tegojs/tego-standard/pull/1883)) (@Toby)
- **client**: 新风格的系统设置 ([#1889](https://github.com/tegojs/tego-standard/pull/1889)) (@sealday)
- 类似菜单的过滤器（WIP）([#1888](https://github.com/tegojs/tego-standard/pull/1888)) (@sealday)
- 站点消息 ([#1856](https://github.com/tegojs/tego-standard/pull/1856)) (@bai.zixv)
- 事件源支持中间件 ([#1885](https://github.com/tegojs/tego-standard/pull/1885)) (@sealday)

### 🐛 修复

- 名称错误 (@sealday)
- 初始化应用程序未加载角色 (@sealday)
- 找不到模块 (@sealday)
- **client**: 系统设置([#1894](https://github.com/tegojs/tego-standard/pull/1894)) (@sealday)
- extern pg 不显示大写表 ([#1893](https://github.com/tegojs/tego-standard/pull/1893)) (@Toby)
- **client**: 导航错误 ([#1892](https://github.com/tegojs/tego-standard/pull/1892)) (@sealday)
- 多应用程序创建错误，需要默认预设 ([#1891](https://github.com/tegojs/tego-standard/pull/1891)) (@Toby)
- 包名错误 (@sealday)
- 模块导出 (@sealday)
- 导入错误 ([#1887](https://github.com/tegojs/tego-standard/pull/1887)) (@sealday)
- Hera hook 迁移到工作流程 ([#1882](https://github.com/tegojs/tego-standard/pull/1882)) (@wjh)
- **server**: 忽略一些加载错误 (@sealday)

### 🔄 变更

- 重命名某些包名称以更好地反映其实际意图 ([#1896](https://github.com/tegojs/tego-standard/pull/1896)) (@sealday)
- **data-source**: 数据源将表迁移到 table-v2 ([#1881](https://github.com/tegojs/tego-standard/pull/1881)) (@WinC159)
- 将移动客户端合并到客户端 ([#1886](https://github.com/tegojs/tego-standard/pull/1886)) (@sealday)
- 干净的代码 ([#1884](https://github.com/tegojs/tego-standard/pull/1884)) (@sealday)

### 📝 文档

- 更新自述文件 (@sealday)
- 更新自述文件.md (@sealday)
- 更新自述文件 (@sealday)
- 修复PNG (@sealday)
- 添加一些案例 (@sealday)


## [0.22.62] - 2024-12-09

### ✨ 新增

- 在工作流程表中添加列 ([#1874](https://github.com/tegojs/tego-standard/pull/1874)) (@bai.zixv)
- 事件源添加数据库事件 ([#1873](https://github.com/tegojs/tego-standard/pull/1873)) (@sealday)
- 间隙按钮区域 ([#1869](https://github.com/tegojs/tego-standard/pull/1869)) (@bai.zixv)
- **cloud-component**: 支持客户端预加载 pdf ([#1859](https://github.com/tegojs/tego-standard/pull/1859)) (@sealday)
- **acl**: 为每个用户生成一个虚拟角色，通过合并所有当前角色形成([#1838](https://github.com/tegojs/tego-standard/pull/1838)) (@Toby)
- **workflow**: 工作流程中的美容节点，历史 ([#1852](https://github.com/tegojs/tego-standard/pull/1852)) (@bai.zixv)
- **workflow**: 美化工作流程中的节点 ([#1848](https://github.com/tegojs/tego-standard/pull/1848)) (@bai.zixv)
- 表/详细信息/表单中的云组件支持 ([#1845](https://github.com/tegojs/tego-standard/pull/1845)) (@sealday)
- 初始化块项目工具栏（技术预览）([#1842](https://github.com/tegojs/tego-standard/pull/1842)) (@sealday)
- 在工作流表中添加集合列 ([#1839](https://github.com/tegojs/tego-standard/pull/1839)) (@bai.zixv)
- **workflow-approval**: 更改摘要搜索实现 ([#1835](https://github.com/tegojs/tego-standard/pull/1835)) (@bai.zixv)
- **cloud-component**: 客户端插件 ([#1837](https://github.com/tegojs/tego-standard/pull/1837)) (@sealday)
- **cloud-component**: 服务器部分([#1825](https://github.com/tegojs/tego-standard/pull/1825)) (@sealday)
- **field-encryption**: 添加插件([#1834](https://github.com/tegojs/tego-standard/pull/1834)) (@bai.zixv)
- filemanger 将表迁移到 tablev2 ([#1827](https://github.com/tegojs/tego-standard/pull/1827)) (@fanyukun)
- **workflow**: 在 CodeMirror 中添加代码注释 ([#1829](https://github.com/tegojs/tego-standard/pull/1829)) (@bai.zixv)
- **event-source**: 在 CodeMirror 中添加评论 ([#1828](https://github.com/tegojs/tego-standard/pull/1828)) (@bai.zixv)
- **event-source**: 同步自定义事件源 ([#1802](https://github.com/tegojs/tego-standard/pull/1802)) (@bai.zixv)
- **workflow**: 工作流程、风格 ([#1822](https://github.com/tegojs/tego-standard/pull/1822)) (@bai.zixv)
- 阻止仅显示自己的多应用程序 ([#1823](https://github.com/tegojs/tego-standard/pull/1823)) (@Toby)
- **client**: 页面模式([#1810](https://github.com/tegojs/tego-standard/pull/1810)) (@sealday)
- **approval**: 在 h5 中添加approvalId ([#1821](https://github.com/tegojs/tego-standard/pull/1821)) (@bai.zixv)
- **messages**: 初始化对消息的支持 ([#1819](https://github.com/tegojs/tego-standard/pull/1819)) (@Toby)
- 在支持快速复制的代码镜像中显示执行历史节点数据 ([#1818](https://github.com/tegojs/tego-standard/pull/1818)) (@fanyukun)
- 美化工作流程节点([#1816](https://github.com/tegojs/tego-standard/pull/1816)) (@bai.zixv)
- 工作流添加重试执行函数 ([#1815](https://github.com/tegojs/tego-standard/pull/1815)) (@fanyukun)
- 分割 NodeDefaultView ([#1814](https://github.com/tegojs/tego-standard/pull/1814)) (@bai.zixv)
- 添加身份验证页面插件并重命名包 ([#1809](https://github.com/tegojs/tego-standard/pull/1809)) (@sealday)
- 布局标题样式阴影 ([#1808](https://github.com/tegojs/tego-standard/pull/1808)) (@bai.zixv)
- 添加工作流程测试 ([#1806](https://github.com/tegojs/tego-standard/pull/1806)) (@sealday)
- 全功能脚本 ([#1803](https://github.com/tegojs/tego-standard/pull/1803)) (@sealday)
- 关于 CodeMirror 的主题灯光模式 ([#1801](https://github.com/tegojs/tego-standard/pull/1801)) (@bai.zixv)
- 由于客户端代码升级而添加脚本来修改数据库架构 ([#1793](https://github.com/tegojs/tego-standard/pull/1793)) (@Toby)
- **workflow**: 执行时间列 ([#1797](https://github.com/tegojs/tego-standard/pull/1797)) (@fanyukun)
- **event-source**: 初始化支持资源定义 ([#1798](https://github.com/tegojs/tego-standard/pull/1798)) (@sealday)
- **approval**: 支持搜索 ID ([#1795](https://github.com/tegojs/tego-standard/pull/1795)) (@bai.zixv)
- 初始化涡轮构建支持([#1791](https://github.com/tegojs/tego-standard/pull/1791)) (@sealday)
- 新旋转 ([#1786](https://github.com/tegojs/tego-standard/pull/1786)) (@sealday)
- 架构初始值设定项支持等待列表 ([#1785](https://github.com/tegojs/tego-standard/pull/1785)) (@sealday)
- **approval**: 更改审批插件中的 Table -> TableV2 ([#1781](https://github.com/tegojs/tego-standard/pull/1781)) (@bai.zixv)
- 动作装饰器支持 acl 选项 ([#1774](https://github.com/tegojs/tego-standard/pull/1774)) (@sealday)
- 工作流程按初始化时间而不是当前创建时间排序 ([#1768](https://github.com/tegojs/tego-standard/pull/1768)) (@Toby)
- 初始化 pdf 模块和重构工作流程模块 ([#1765](https://github.com/tegojs/tego-standard/pull/1765)) (@sealday)
- **client**: 向页面添加滚动区域 ([#1755](https://github.com/tegojs/tego-standard/pull/1755)) (@bai.zixv)
- **approval**: 模糊批准搜索([#1760](https://github.com/tegojs/tego-standard/pull/1760)) (@bai.zixv)
- 调整弹出标签存储([#1753](https://github.com/tegojs/tego-standard/pull/1753)) (@wjh)
- **auth**: 用户绑定机制和微信验证现在支持用户绑定([#1740](https://github.com/tegojs/tego-standard/pull/1740)) (@Toby)
- **scripts**: 检测空项目文件夹 ([#1744](https://github.com/tegojs/tego-standard/pull/1744)) (@fanyukun)
- 对 mako 的实验性支持 ([#1747](https://github.com/tegojs/tego-standard/pull/1747)) (@sealday)
- **approval**: 摘要搜索 ([#1741](https://github.com/tegojs/tego-standard/pull/1741)) (@bai.zixv)
- 动态模式道具装饰器 ([#1742](https://github.com/tegojs/tego-standard/pull/1742)) (@sealday)
- 添加脚本来检查包名称是否正确，并对错误的包名称提供自动更正。  (@fanyukun)
- 结算单计算触发工作流 ([#1733](https://github.com/tegojs/tego-standard/pull/1733)) (@wjh)
- **scripts**: 添加检查名称脚本 ([#1732](https://github.com/tegojs/tego-standard/pull/1732)) (@sealday)
- 现在可以保存工作流程缩放状态和分割器大小状态([#1725](https://github.com/tegojs/tego-standard/pull/1725)) (@sealday)
- 添加工作流分支状态&合同状态更新脚本 ([#1721](https://github.com/tegojs/tego-standard/pull/1721)) (@wjh)
- 工作流程添加 moveUp 和 moveDown ([#1724](https://github.com/tegojs/tego-standard/pull/1724)) (@sealday)
- **workflow**: 向工作流表添加刷新和过滤器 ([#1716](https://github.com/tegojs/tego-standard/pull/1716)) (@bai.zixv)
- **tb**: 支持上下文菜单项排序 ([#1714](https://github.com/tegojs/tego-standard/pull/1714)) (@bai.zixv)
- 添加演示应用程序 ([#1712](https://github.com/tegojs/tego-standard/pull/1712)) (@sealday)
- 修复包 json ([#1711](https://github.com/tegojs/tego-standard/pull/1711)) (@bai.zixv)
- 添加 clean 命令来删除所有文件 ([#1710](https://github.com/tegojs/tego-standard/pull/1710)) (@sealday)
- 系统设置访问保持公开 ([#1706](https://github.com/tegojs/tego-standard/pull/1706)) (@bai.zixv)
- 支持不同工作流程之间的交互和调用([#1692](https://github.com/tegojs/tego-standard/pull/1692)) (@Toby)
- 更改翻译文案 ([#1704](https://github.com/tegojs/tego-standard/pull/1704)) (@bai.zixv)
- **departments**: 支持显示所有成员 ([#1686](https://github.com/tegojs/tego-standard/pull/1686)) (@Toby)
- 对基于 React 的 PDF 渲染的实验性支持 ([#1703](https://github.com/tegojs/tego-standard/pull/1703)) (@sealday)
- 移动使用repository.update ([#1689](https://github.com/tegojs/tego-standard/pull/1689)) (@Toby)
- 添加演示游戏块 runesweeper ([#1684](https://github.com/tegojs/tego-standard/pull/1684)) (@sealday)
- svg类型图片预览 ([#1669](https://github.com/tegojs/tego-standard/pull/1669)) (@wjh)
- 添加多应用程序管理器块([#1668](https://github.com/tegojs/tego-standard/pull/1668)) (@Toby)
- 新的菜单用户界面 ([#1664](https://github.com/tegojs/tego-standard/pull/1664)) (@sealday)
- **approval**: 添加翻译文本 ([#1658](https://github.com/tegojs/tego-standard/pull/1658)) (@bai.zixv)
- 结算单新增期限免租&最短租期计算方式 ([#1651](https://github.com/tegojs/tego-standard/pull/1651)) (@wjh)
- 滚动助手现在支持滚轮事件 ([#1654](https://github.com/tegojs/tego-standard/pull/1654)) (@sealday)
- **tb**: 更新图标 ([#1648](https://github.com/tegojs/tego-standard/pull/1648)) (@bai.zixv)

### 🐛 修复

- Hera hook 迁移到工作流程 ([#1875](https://github.com/tegojs/tego-standard/pull/1875)) (@wjh)
- 恢复到旧的工具提示版本 (@sealday)
- 启动后找不到数据库实例 (@sealday)
- 容器在初始化时无法加载控制器 (@sealday)
- dev 使用相对路径以便于复制 (@sealday)
- 更改 tachybase 的链接 (@sealday)
- 当 Hera 未加载时，Web 服务不会加载 ([#1876](https://github.com/tegojs/tego-standard/pull/1876)) (@sealday)
- 版本检查 (@sealday)
- 历史节点 ([#1872](https://github.com/tegojs/tego-standard/pull/1872)) (@bai.zixv)
- **cloud-component**: 云组件和事件源之间的架构冲突问题 ([#1870](https://github.com/tegojs/tego-standard/pull/1870)) (@sealday)
- 历史节点 ([#1868](https://github.com/tegojs/tego-standard/pull/1868)) (@bai.zixv)
- Hera hook 迁移到工作流程 ([#1862](https://github.com/tegojs/tego-standard/pull/1862)) (@wjh)
- **department**: 部门显示所有成员错误，无法从角色中删除部门 ([#1860](https://github.com/tegojs/tego-standard/pull/1860)) (@Toby)
- Hera 前端组件迁移到云组件 ([#1858](https://github.com/tegojs/tego-standard/pull/1858)) (@wjh)
- Hera 自定义组件迁移到云组件 ([#1853](https://github.com/tegojs/tego-standard/pull/1853)) (@wjh)
- **cloud-component**: 开发时加载包 ([#1854](https://github.com/tegojs/tego-standard/pull/1854)) (@sealday)
- **client**: 递归组件只显示最里面的工具栏 (@sealday)
- **cloud-component**: 无法加载备忘录功能 ([#1850](https://github.com/tegojs/tego-standard/pull/1850)) (@sealday)
- 云组件启用错误 ([#1847](https://github.com/tegojs/tego-standard/pull/1847)) (@Toby)
- 看板 (@sealday)
- **cloud-component**: 立即生效 (@sealday)
- 云组件在表中工作 (@sealday)
- 新型工具栏的可设计工作([#1846](https://github.com/tegojs/tego-standard/pull/1846)) (@sealday)
- **cloud-component**: 身份验证错误 ([#1841](https://github.com/tegojs/tego-standard/pull/1841)) (@sealday)
- **approval**: 模糊搜索参数错误 ([#1840](https://github.com/tegojs/tego-standard/pull/1840)) (@bai.zixv)
- **client**: 显示重复创建成功消息 ([#1831](https://github.com/tegojs/tego-standard/pull/1831)) (@fanyukun)
- 添加记录 is_end 字段 ([#1833](https://github.com/tegojs/tego-standard/pull/1833)) (@wjh)
- **export**: 查找之前预计数 ([#1832](https://github.com/tegojs/tego-standard/pull/1832)) (@Toby)
- **collection-manager**: 导入表不再导入类别，导入失败也不会刷新页面 ([#1830](https://github.com/tegojs/tego-standard/pull/1830)) (@Toby)
- **acl**: 消息：ACL 错误，多应用程序应向登录授予“列表”权限 ([#1826](https://github.com/tegojs/tego-standard/pull/1826)) (@Toby)
- 模板仅获取所有者或管理员集 ([#1824](https://github.com/tegojs/tego-standard/pull/1824)) (@Toby)
- 结算单不触发凭证自动更新([#1820](https://github.com/tegojs/tego-standard/pull/1820)) (@wjh)
- acl [查看、更新、销毁] 检查包含许多包含导致 cpu 崩溃 ([#1817](https://github.com/tegojs/tego-standard/pull/1817)) (@Toby)
- 只读错误 ([#1812](https://github.com/tegojs/tego-standard/pull/1812)) (@bai.zixv)
- pdf 记录器 ([#1811](https://github.com/tegojs/tego-standard/pull/1811)) (@sealday)
- 恢复 mako 默认值 ([#1805](https://github.com/tegojs/tego-standard/pull/1805)) (@sealday)
- 唯一密钥approvalProvider ([#1800](https://github.com/tegojs/tego-standard/pull/1800)) (@bai.zixv)
- 调整 SVG 组件 ([#1799](https://github.com/tegojs/tego-standard/pull/1799)) (@wjh)
- 链接规则导致多次请求 ([#1792](https://github.com/tegojs/tego-standard/pull/1792)) (@bai.zixv)
- **approval**: 批准 ApprovalBlock.Launch.Application ([#1788](https://github.com/tegojs/tego-standard/pull/1788)) (@bai.zixv)
- moudle pdf 构建 ([#1787](https://github.com/tegojs/tego-standard/pull/1787)) (@sealday)
- 工作流审批移动插件删除 ([#1782](https://github.com/tegojs/tego-standard/pull/1782)) (@sealday)
- **approval**: 翻译命名空间 ([#1780](https://github.com/tegojs/tego-standard/pull/1780)) (@bai.zixv)
- 工作流程查看历史节点并配置和添加类别键 ([#1776](https://github.com/tegojs/tego-standard/pull/1776)) (@wjh)
- 模块 i18n ([#1770](https://github.com/tegojs/tego-standard/pull/1770)) (@sealday)
- **client**: 滚动 ([#1771](https://github.com/tegojs/tego-standard/pull/1771)) (@bai.zixv)
- 模块 pdf 和事件源应默认启用 ([#1767](https://github.com/tegojs/tego-standard/pull/1767)) (@sealday)
- 相同的 auth public 不能被登录覆盖([#1764](https://github.com/tegojs/tego-standard/pull/1764)) (@Toby)
- 结算单费用计算和 PDF 视图 ([#1763](https://github.com/tegojs/tego-standard/pull/1763)) (@wjh)
- **approval**: useSubmit 表单状态已修复 ([#1762](https://github.com/tegojs/tego-standard/pull/1762)) (@bai.zixv)
- 控制器初始化失败 ([#1758](https://github.com/tegojs/tego-standard/pull/1758)) (@sealday)
- getUserInfo 显示绑定昵称，限制登录超时 (@Toby)
- 代理端口失败 (@sealday)
- 移动标签搜索组件的日期适配 ([#1746](https://github.com/tegojs/tego-standard/pull/1746)) (@wjh)
- pdf-viewer 可在 PC 中滚动并重构 mobile-provider ([#1739](https://github.com/tegojs/tego-standard/pull/1739)) (@sealday)
- useTranslation 时出现类型错误 ([#1736](https://github.com/tegojs/tego-standard/pull/1736)) (@sealday)
- umi 模块查找失败 ([#1731](https://github.com/tegojs/tego-standard/pull/1731)) (@sealday)
- 忽略租赁升级错误 ([#1730](https://github.com/tegojs/tego-standard/pull/1730)) (@sealday)
- 修改结算单关联赔偿支持订单金额 ([#1727](https://github.com/tegojs/tego-standard/pull/1727)) (@wjh)
- 向上移动时不要更改工作流节点键 ([#1728](https://github.com/tegojs/tego-standard/pull/1728)) (@sealday)
- 工作流程按类型保存状态 ([#1726](https://github.com/tegojs/tego-standard/pull/1726)) (@sealday)
- cli 和 docker 文件路径错误 ([#1722](https://github.com/tegojs/tego-standard/pull/1722)) (@Toby)
- **approval**: 修复审批显示金额错误 (@bai.zixv)
- 视口，元缩放，1.0 ([#1713](https://github.com/tegojs/tego-standard/pull/1713)) (@bai.zixv)
- **approval**: 当某些状态发生变化时禁止触发工作流程 ([#1709](https://github.com/tegojs/tego-standard/pull/1709)) (@bai.zixv)
- 云组件现在可以在开发和生产环境中运行 ([#1702](https://github.com/tegojs/tego-standard/pull/1702)) (@sealday)
- **page-tab**: 关闭标签上的 stopPropagation ([#1700](https://github.com/tegojs/tego-standard/pull/1700)) (@bai.zixv)
- 快速入门([#1696](https://github.com/tegojs/tego-standard/pull/1696)) (@sealday)
- 完善欢迎卡片 ([#1695](https://github.com/tegojs/tego-standard/pull/1695)) (@bai.zixv)
- 修复结算单最短租期显示 ([#1691](https://github.com/tegojs/tego-standard/pull/1691)) (@wjh)
- 工作流内嵌弹窗样式问题 ([#1687](https://github.com/tegojs/tego-standard/pull/1687)) (@wjh)
- 切换到其他选项卡后选项卡面板重置 ([#1690](https://github.com/tegojs/tego-standard/pull/1690)) (@sealday)
- docker 入口点 ([#1685](https://github.com/tegojs/tego-standard/pull/1685)) (@sealday)
- 哨兵路径错误 ([#1682](https://github.com/tegojs/tego-standard/pull/1682)) (@sealday)
- pdf dist 文件 ([#1679](https://github.com/tegojs/tego-standard/pull/1679)) (@sealday)
- **approval**: 批准待办事项显示流程组件错误 ([#1674](https://github.com/tegojs/tego-standard/pull/1674)) (@bai.zixv)
- 图迁移 ([#1675](https://github.com/tegojs/tego-standard/pull/1675)) (@sealday)
- 操作表翻译 ([#1673](https://github.com/tegojs/tego-standard/pull/1673)) (@sealday)
- 将 Excel 导出和日期格式限制为带有客户端时区的字符串 ([#1661](https://github.com/tegojs/tego-standard/pull/1661)) (@Toby)
- 修改下拉框设置默认值不生效 ([#1662](https://github.com/tegojs/tego-standard/pull/1662)) (@wjh)
- **tb**: 修复平板设备过于缩小问题 ([#1655](https://github.com/tegojs/tego-standard/pull/1655)) (@bai.zixv)
- 修复工作流审批节点保存报错 ([#1653](https://github.com/tegojs/tego-standard/pull/1653)) (@wjh)
- **client**: 子菜单显示空标签 ([#1652](https://github.com/tegojs/tego-standard/pull/1652)) (@sealday)

### 🔄 变更

- **hera**: 干净的代码 ([#1880](https://github.com/tegojs/tego-standard/pull/1880)) (@sealday)
- 删除未使用的通知模块 (@sealday)
- 删除原型 pdf 编辑器（合并到云组件中） (@sealday)
- **hera**: 干净的代码 ([#1865](https://github.com/tegojs/tego-standard/pull/1865)) (@sealday)
- 为节点添加自定义图标 ([#1855](https://github.com/tegojs/tego-standard/pull/1855)) (@bai.zixv)
- 重命名包([#1844](https://github.com/tegojs/tego-standard/pull/1844)) (@sealday)
- 工作流模块，分割默认节点视图 ([#1813](https://github.com/tegojs/tego-standard/pull/1813)) (@bai.zixv)
- **client**: 将 useCreateActionProps 和提交按钮操作从 hera 迁移到客户端 ([#1789](https://github.com/tegojs/tego-standard/pull/1789)) (@wjh)
- **workflow**: 工作流程执行移至表 v2 ([#1790](https://github.com/tegojs/tego-standard/pull/1790)) (@fanyukun)
- 批准([#1796](https://github.com/tegojs/tego-standard/pull/1796)) (@bai.zixv)
- 批准([#1794](https://github.com/tegojs/tego-standard/pull/1794)) (@bai.zixv)
- 删除兼容架构 ([#1784](https://github.com/tegojs/tego-standard/pull/1784)) (@sealday)
- **workflow**: 工作流程将表迁移到 TableV2 ([#1761](https://github.com/tegojs/tego-standard/pull/1761)) (@fanyukun)
- **approval**: 重命名包([#1779](https://github.com/tegojs/tego-standard/pull/1779)) (@sealday)
- 带有 antd 警报组件的通知区域 ([#1775](https://github.com/tegojs/tego-standard/pull/1775)) (@sealday)
- 批准([#1772](https://github.com/tegojs/tego-standard/pull/1772)) (@bai.zixv)
- 批准([#1769](https://github.com/tegojs/tego-standard/pull/1769)) (@bai.zixv)
- **approval**: 批准([#1749](https://github.com/tegojs/tego-standard/pull/1749)) (@bai.zixv)
- **client**: 分离出 requirejs ([#1754](https://github.com/tegojs/tego-standard/pull/1754)) (@sealday)
- **client**: tachybase 客户端自我引用 ([#1748](https://github.com/tegojs/tego-standard/pull/1748)) (@sealday)
- **approval**: 批准块启动架构 ([#1735](https://github.com/tegojs/tego-standard/pull/1735)) (@bai.zixv)
- 重命名为模块 ([#1729](https://github.com/tegojs/tego-standard/pull/1729)) (@sealday)
- 把js改成ts (@sealday)
- 更改批准文件名 ([#1720](https://github.com/tegojs/tego-standard/pull/1720)) (@bai.zixv)
- **approval**: 更改批准文件 ([#1719](https://github.com/tegojs/tego-standard/pull/1719)) (@bai.zixv)
- **lint**: 删除未使用的 lint deps ([#1718](https://github.com/tegojs/tego-standard/pull/1718)) (@sealday)
- mv 应用程序从包到应用程序 ([#1708](https://github.com/tegojs/tego-standard/pull/1708)) (@sealday)
- 人工智能助手和云组件 ([#1694](https://github.com/tegojs/tego-standard/pull/1694)) (@sealday)
- mv @hera 插件到 @tachybase 命名空间 ([#1683](https://github.com/tegojs/tego-standard/pull/1683)) (@sealday)
- 数据源([#1665](https://github.com/tegojs/tego-standard/pull/1665)) (@sealday)
- 重构下拉菜单，统一模态窗和抽屉的 UI，新增快捷入口区块 ([#1649](https://github.com/tegojs/tego-standard/pull/1649)) (@sealday)
- **approval**: 迁移审批插件 ([#1773](https://github.com/tegojs/tego-standard/pull/1773)) (@bai.zixv)
- 改进 lint ([#1717](https://github.com/tegojs/tego-standard/pull/1717)) (@sealday)
- 工作流 HTTP给个写备注的地方. 以防后续不知道节点数据含义 ([#1672](https://github.com/tegojs/tego-standard/pull/1672)) (@Toby)

### 📝 文档

- 更新自述文件 (@sealday)
- 更新自述文件 (@sealday)
- 更新自述文件 (@sealday)
- 更新自述文件 (@sealday)
- 更新README.md (@sealday)
- 自述文件.md (@sealday)
- 更新自述文件.md (@sealday)
- 更新 readme.md ([#1807](https://github.com/tegojs/tego-standard/pull/1807)) (@sealday)
- 更新自述文件.md (@sealday)
- 更新自述文件 ([#1756](https://github.com/tegojs/tego-standard/pull/1756)) (@sealday)
- 更新许可证 (@sealday)
- 更新自述文件.md (@sealday)
- 更新 readme.md ([#1751](https://github.com/tegojs/tego-standard/pull/1751)) (@sealday)
- 更新自述文件 ([#1663](https://github.com/tegojs/tego-standard/pull/1663)) (@sealday)
- 更新自述文件 ([#1656](https://github.com/tegojs/tego-standard/pull/1656)) (@sealday)


## [0.0.3] - 2024-12-16

### ✨ 新增

- 支持 pg_client，图像中的 zip ([#1913](https://github.com/tegojs/tego-standard/pull/1913)) (@Toby)
- **client**: 优化调试体验 (@sealday)
- 工作微信使用手机作为唯一密钥 ([#1904](https://github.com/tegojs/tego-standard/pull/1904)) (@Toby)
- 在工作流程和站点消息中添加 WorkflowVariableCodeMirror 和其他修复 ([#1890](https://github.com/tegojs/tego-standard/pull/1890)) (@bai.zixv)
- toposort 支持独特选项 ([#1902](https://github.com/tegojs/tego-standard/pull/1902)) (@sealday)
- cron 作业插件使用工作流程，而不是触发器类型 ([#1883](https://github.com/tegojs/tego-standard/pull/1883)) (@Toby)
- **client**: 新风格的系统设置 ([#1889](https://github.com/tegojs/tego-standard/pull/1889)) (@sealday)
- 类似菜单的过滤器（WIP）([#1888](https://github.com/tegojs/tego-standard/pull/1888)) (@sealday)
- 站点消息 ([#1856](https://github.com/tegojs/tego-standard/pull/1856)) (@bai.zixv)
- 事件源支持中间件 ([#1885](https://github.com/tegojs/tego-standard/pull/1885)) (@sealday)
- 在工作流程表中添加列 ([#1874](https://github.com/tegojs/tego-standard/pull/1874)) (@bai.zixv)
- 事件源添加数据库事件 ([#1873](https://github.com/tegojs/tego-standard/pull/1873)) (@sealday)
- 间隙按钮区域 ([#1869](https://github.com/tegojs/tego-standard/pull/1869)) (@bai.zixv)
- **cloud-component**: 支持客户端预加载 pdf ([#1859](https://github.com/tegojs/tego-standard/pull/1859)) (@sealday)
- **acl**: 为每个用户生成一个虚拟角色，通过合并所有当前角色形成([#1838](https://github.com/tegojs/tego-standard/pull/1838)) (@Toby)
- **workflow**: 工作流程中的美容节点，历史 ([#1852](https://github.com/tegojs/tego-standard/pull/1852)) (@bai.zixv)
- **workflow**: 美化工作流程中的节点 ([#1848](https://github.com/tegojs/tego-standard/pull/1848)) (@bai.zixv)
- 表/详细信息/表单中的云组件支持 ([#1845](https://github.com/tegojs/tego-standard/pull/1845)) (@sealday)
- 初始化块项目工具栏（技术预览）([#1842](https://github.com/tegojs/tego-standard/pull/1842)) (@sealday)
- 在工作流表中添加集合列 ([#1839](https://github.com/tegojs/tego-standard/pull/1839)) (@bai.zixv)
- **workflow-approval**: 更改摘要搜索实现 ([#1835](https://github.com/tegojs/tego-standard/pull/1835)) (@bai.zixv)
- **cloud-component**: 客户端插件 ([#1837](https://github.com/tegojs/tego-standard/pull/1837)) (@sealday)
- **cloud-component**: 服务器部分([#1825](https://github.com/tegojs/tego-standard/pull/1825)) (@sealday)
- **field-encryption**: 添加插件([#1834](https://github.com/tegojs/tego-standard/pull/1834)) (@bai.zixv)
- filemanger 将表迁移到 tablev2 ([#1827](https://github.com/tegojs/tego-standard/pull/1827)) (@fanyukun)
- **workflow**: 在 CodeMirror 中添加代码注释 ([#1829](https://github.com/tegojs/tego-standard/pull/1829)) (@bai.zixv)
- **event-source**: 在 CodeMirror 中添加评论 ([#1828](https://github.com/tegojs/tego-standard/pull/1828)) (@bai.zixv)
- **event-source**: 同步自定义事件源 ([#1802](https://github.com/tegojs/tego-standard/pull/1802)) (@bai.zixv)
- **workflow**: 工作流程、风格 ([#1822](https://github.com/tegojs/tego-standard/pull/1822)) (@bai.zixv)
- 阻止仅显示自己的多应用程序 ([#1823](https://github.com/tegojs/tego-standard/pull/1823)) (@Toby)
- **client**: 页面模式([#1810](https://github.com/tegojs/tego-standard/pull/1810)) (@sealday)
- **approval**: 在 h5 中添加approvalId ([#1821](https://github.com/tegojs/tego-standard/pull/1821)) (@bai.zixv)
- **messages**: 初始化对消息的支持 ([#1819](https://github.com/tegojs/tego-standard/pull/1819)) (@Toby)
- 在支持快速复制的代码镜像中显示执行历史节点数据 ([#1818](https://github.com/tegojs/tego-standard/pull/1818)) (@fanyukun)
- 美化工作流程节点([#1816](https://github.com/tegojs/tego-standard/pull/1816)) (@bai.zixv)
- 工作流添加重试执行函数 ([#1815](https://github.com/tegojs/tego-standard/pull/1815)) (@fanyukun)
- 分割 NodeDefaultView ([#1814](https://github.com/tegojs/tego-standard/pull/1814)) (@bai.zixv)
- 添加身份验证页面插件并重命名包 ([#1809](https://github.com/tegojs/tego-standard/pull/1809)) (@sealday)
- 布局标题样式阴影 ([#1808](https://github.com/tegojs/tego-standard/pull/1808)) (@bai.zixv)
- 添加工作流程测试 ([#1806](https://github.com/tegojs/tego-standard/pull/1806)) (@sealday)
- 全功能脚本 ([#1803](https://github.com/tegojs/tego-standard/pull/1803)) (@sealday)
- 关于 CodeMirror 的主题灯光模式 ([#1801](https://github.com/tegojs/tego-standard/pull/1801)) (@bai.zixv)
- 由于客户端代码升级而添加脚本来修改数据库架构 ([#1793](https://github.com/tegojs/tego-standard/pull/1793)) (@Toby)
- **workflow**: 执行时间列 ([#1797](https://github.com/tegojs/tego-standard/pull/1797)) (@fanyukun)
- **event-source**: 初始化支持资源定义 ([#1798](https://github.com/tegojs/tego-standard/pull/1798)) (@sealday)
- **approval**: 支持搜索 ID ([#1795](https://github.com/tegojs/tego-standard/pull/1795)) (@bai.zixv)
- 初始化涡轮构建支持([#1791](https://github.com/tegojs/tego-standard/pull/1791)) (@sealday)
- 新旋转 ([#1786](https://github.com/tegojs/tego-standard/pull/1786)) (@sealday)
- 架构初始值设定项支持等待列表 ([#1785](https://github.com/tegojs/tego-standard/pull/1785)) (@sealday)
- **approval**: 更改审批插件中的 Table -> TableV2 ([#1781](https://github.com/tegojs/tego-standard/pull/1781)) (@bai.zixv)
- 动作装饰器支持 acl 选项 ([#1774](https://github.com/tegojs/tego-standard/pull/1774)) (@sealday)
- 工作流程按初始化时间而不是当前创建时间排序 ([#1768](https://github.com/tegojs/tego-standard/pull/1768)) (@Toby)
- 初始化 pdf 模块和重构工作流程模块 ([#1765](https://github.com/tegojs/tego-standard/pull/1765)) (@sealday)
- **client**: 向页面添加滚动区域 ([#1755](https://github.com/tegojs/tego-standard/pull/1755)) (@bai.zixv)
- **approval**: 模糊批准搜索([#1760](https://github.com/tegojs/tego-standard/pull/1760)) (@bai.zixv)
- 调整弹出标签存储([#1753](https://github.com/tegojs/tego-standard/pull/1753)) (@wjh)
- **auth**: 用户绑定机制和微信验证现在支持用户绑定([#1740](https://github.com/tegojs/tego-standard/pull/1740)) (@Toby)
- **scripts**: 检测空项目文件夹 ([#1744](https://github.com/tegojs/tego-standard/pull/1744)) (@fanyukun)
- 对 mako 的实验性支持 ([#1747](https://github.com/tegojs/tego-standard/pull/1747)) (@sealday)
- **approval**: 摘要搜索 ([#1741](https://github.com/tegojs/tego-standard/pull/1741)) (@bai.zixv)
- 动态模式道具装饰器 ([#1742](https://github.com/tegojs/tego-standard/pull/1742)) (@sealday)
- 添加脚本来检查包名称是否正确，并对错误的包名称提供自动更正。  (@fanyukun)
- 结算单计算触发工作流 ([#1733](https://github.com/tegojs/tego-standard/pull/1733)) (@wjh)
- **scripts**: 添加检查名称脚本 ([#1732](https://github.com/tegojs/tego-standard/pull/1732)) (@sealday)
- 现在可以保存工作流程缩放状态和分割器大小状态([#1725](https://github.com/tegojs/tego-standard/pull/1725)) (@sealday)
- 添加工作流分支状态&合同状态更新脚本 ([#1721](https://github.com/tegojs/tego-standard/pull/1721)) (@wjh)
- 工作流程添加 moveUp 和 moveDown ([#1724](https://github.com/tegojs/tego-standard/pull/1724)) (@sealday)
- **workflow**: 向工作流表添加刷新和过滤器 ([#1716](https://github.com/tegojs/tego-standard/pull/1716)) (@bai.zixv)
- **tb**: 支持上下文菜单项排序 ([#1714](https://github.com/tegojs/tego-standard/pull/1714)) (@bai.zixv)
- 添加演示应用程序 ([#1712](https://github.com/tegojs/tego-standard/pull/1712)) (@sealday)
- 修复包 json ([#1711](https://github.com/tegojs/tego-standard/pull/1711)) (@bai.zixv)
- 添加 clean 命令来删除所有文件 ([#1710](https://github.com/tegojs/tego-standard/pull/1710)) (@sealday)
- 系统设置访问保持公开 ([#1706](https://github.com/tegojs/tego-standard/pull/1706)) (@bai.zixv)
- 支持不同工作流程之间的交互和调用([#1692](https://github.com/tegojs/tego-standard/pull/1692)) (@Toby)
- 更改翻译文案 ([#1704](https://github.com/tegojs/tego-standard/pull/1704)) (@bai.zixv)
- **departments**: 支持显示所有成员 ([#1686](https://github.com/tegojs/tego-standard/pull/1686)) (@Toby)
- 对基于 React 的 PDF 渲染的实验性支持 ([#1703](https://github.com/tegojs/tego-standard/pull/1703)) (@sealday)
- 移动使用repository.update ([#1689](https://github.com/tegojs/tego-standard/pull/1689)) (@Toby)
- 添加演示游戏块 runesweeper ([#1684](https://github.com/tegojs/tego-standard/pull/1684)) (@sealday)
- svg类型图片预览 ([#1669](https://github.com/tegojs/tego-standard/pull/1669)) (@wjh)
- 添加多应用程序管理器块([#1668](https://github.com/tegojs/tego-standard/pull/1668)) (@Toby)
- 新的菜单用户界面 ([#1664](https://github.com/tegojs/tego-standard/pull/1664)) (@sealday)
- **approval**: 添加翻译文本 ([#1658](https://github.com/tegojs/tego-standard/pull/1658)) (@bai.zixv)
- 结算单新增期限免租&最短租期计算方式 ([#1651](https://github.com/tegojs/tego-standard/pull/1651)) (@wjh)
- 滚动助手现在支持滚轮事件 ([#1654](https://github.com/tegojs/tego-standard/pull/1654)) (@sealday)
- **tb**: 更新图标 ([#1648](https://github.com/tegojs/tego-standard/pull/1648)) (@bai.zixv)
- **tb**: 图标更替 ([#1633](https://github.com/tegojs/tego-standard/pull/1633)) ([#1641](https://github.com/tegojs/tego-standard/pull/1641)) (@sealday)
- 初始化支持混音 ([#1628](https://github.com/tegojs/tego-standard/pull/1628)) (@sealday)
- 删掉hera多余的sql,支持在sql语句第一行-- dialect: postgres 这样提明支持的dialect ([#1627](https://github.com/tegojs/tego-standard/pull/1627)) (@Toby)
- **red-node**: init 支持红节点适配器 ([#1621](https://github.com/tegojs/tego-standard/pull/1621)) (@sealday)
- 附件添加图像的默认预览方式 ([#1614](https://github.com/tegojs/tego-standard/pull/1614)) (@bai.zixv)
- 改进 tachybase 预设 ([#1609](https://github.com/tegojs/tego-standard/pull/1609)) (@sealday)
- **client**: 添加欢迎卡 ([#1606](https://github.com/tegojs/tego-standard/pull/1606)) (@sealday)
- **workflow**: 支持 api 挂钩 ([#1591](https://github.com/tegojs/tego-standard/pull/1591)) (@sealday)
- **数据表**: REST API ([#1567](https://github.com/tegojs/tego-standard/pull/1567)) (@bai.zixv)
- 网络通知([#1573](https://github.com/tegojs/tego-standard/pull/1573)) (@sealday)
- **workflow**: 移除工作流操作类型的触发事件 ([#1561](https://github.com/tegojs/tego-standard/pull/1561)) (@bai.zixv)
- 数据表导入导出 ([#1550](https://github.com/tegojs/tego-standard/pull/1550)) (@sealday)
- 订阅渠道管理 ([#1546](https://github.com/tegojs/tego-standard/pull/1546)) (@sealday)
- 用户设置页面 ([#1540](https://github.com/tegojs/tego-standard/pull/1540)) (@sealday)
- 通知与个人页面改版（WIP） ([#1455](https://github.com/tegojs/tego-standard/pull/1455)) (@sealday)
- 右键代码移到core，添加右键区块全屏操作 ([#1524](https://github.com/tegojs/tego-standard/pull/1524)) (@wjh)
- **dianziqian**: url保存附件支持json格式 ([#1517](https://github.com/tegojs/tego-standard/pull/1517)) (@wanggang)
- **plugin-wechat-auth**: 微信二维码登录 ([#1516](https://github.com/tegojs/tego-standard/pull/1516)) (@TomyJan)
- **workflow**: 调度程序支持传递用户信息 ([#1512](https://github.com/tegojs/tego-standard/pull/1512)) (@sealday)
- **multi-app-manager**: 自定义子应用程序启动选项([#1498](https://github.com/tegojs/tego-standard/pull/1498))([#1506](https://github.com/tegojs/tego-standard/pull/1506)) (@TomyJan)
- 新增自定义跳转页面 ([#1499](https://github.com/tegojs/tego-standard/pull/1499)) (@bai.zixv)
- **multi-app-manager**: 手动操作子应用程序 ([#1488](https://github.com/tegojs/tego-standard/pull/1488)) (@TomyJan)
- **approval**: v2([#1476](https://github.com/tegojs/tego-standard/pull/1476)) (@bai.zixv)
- **multi-app-manager**: 通过 tmpl 创建子应用程序 ([#1469](https://github.com/tegojs/tego-standard/pull/1469)) (@TomyJan)
- 新增自定义筛选组件，调整筛选字段内容 ([#1468](https://github.com/tegojs/tego-standard/pull/1468)) (@wjh)
- **telemetry**: 添加 `Sentry` 作为前端遥测 ([#1458](https://github.com/tegojs/tego-standard/pull/1458)) (@TomyJan)
- 多对多关系可以添加关联 ([#1333](https://github.com/tegojs/tego-standard/pull/1333)) (@wjh)
- 查看表单值 ([#1443](https://github.com/tegojs/tego-standard/pull/1443)) (@sealday)
- oneClick 发布微信公众号推文 ([#1417](https://github.com/tegojs/tego-standard/pull/1417)) (@luliangqiang)
- **client**: antd升级到5.19.4，designable模式现在可以直接编辑组件schema了。 (@sealday)
- **workflow**: 支持在工作流创建/更新节点中分配附件字段。  (@sealday)
- 区块链([#1408](https://github.com/tegojs/tego-standard/pull/1408)) (@hua)
- **omni-trigger**: 来自参数的资源名称 ([#1416](https://github.com/tegojs/tego-standard/pull/1416)) (@bai.zixv)
- 准备演示阶段 1 ([#1412](https://github.com/tegojs/tego-standard/pull/1412)) (@sealday)
- **telemetry**: 将 otlp 格式的迹线数据和矩阵数据导出到 prometheus ([#1400](https://github.com/tegojs/tego-standard/pull/1400)) (@TomyJan)
- 微信公众号登录插件-未重定向 ([#1405](https://github.com/tegojs/tego-standard/pull/1405)) (@luliangqiang)
- **data-mapping**: 添加新用法 ([#1403](https://github.com/tegojs/tego-standard/pull/1403)) (@bai.zixv)
- **approval**: 批准后隐藏 updateForm ([#1397](https://github.com/tegojs/tego-standard/pull/1397)) (@bai.zixv)
- 将 code-mirror 替换为 monaco ([#1395](https://github.com/tegojs/tego-standard/pull/1395)) (@sealday)
- 将word转pdf ([#1380](https://github.com/tegojs/tego-standard/pull/1380)) (@yoona)
- 遥测初始化 ([#1378](https://github.com/tegojs/tego-standard/pull/1378)) (@TomyJan)
- 添加下载文档和显示数据按钮 ([#1370](https://github.com/tegojs/tego-standard/pull/1370)) (@wjh)
- 企业微信扫码登录插件 ([#1364](https://github.com/tegojs/tego-standard/pull/1364)) (@huahua)
- 插件-bullmq-适配器 ([#1365](https://github.com/tegojs/tego-standard/pull/1365)) (@sealday)
- 分享([#1358](https://github.com/tegojs/tego-standard/pull/1358)) (@TomyJan)
- 批准，抄送唯一记录 ([#1349](https://github.com/tegojs/tego-standard/pull/1349)) (@bai.zixv)
- 官方账号 ([#1348](https://github.com/tegojs/tego-standard/pull/1348)) (@ALIANG)
- 工作流程、结束节点、直通结果 ([#1344](https://github.com/tegojs/tego-standard/pull/1344)) (@bai.zixv)
- 钉钉 ([#1340](https://github.com/tegojs/tego-standard/pull/1340)) (@sealday)
- 打印模板 ([#1338](https://github.com/tegojs/tego-standard/pull/1338)) (@yoona)
- 批准，抄送 ([#1330](https://github.com/tegojs/tego-standard/pull/1330)) (@bai.zixv)
- 访问令牌([#1320](https://github.com/tegojs/tego-standard/pull/1320)) (@sealday)
- 批准，todo 发起者 ([#1317](https://github.com/tegojs/tego-standard/pull/1317)) (@bai.zixv)
- pc端发起审批模块 ([#1316](https://github.com/tegojs/tego-standard/pull/1316)) (@wjh)
- 数据映射，完成([#1312](https://github.com/tegojs/tego-standard/pull/1312)) (@bai.zixv)
- codemirror，添加主题 ([#1311](https://github.com/tegojs/tego-standard/pull/1311)) (@bai.zixv)
- 工作流触发器支持黑名单 ([#1309](https://github.com/tegojs/tego-standard/pull/1309)) (@sealday)
- jsparse，添加加密库和功能：jsparse、jscode tooptip 和修复：工作流程、json 解析、CodeMirror ([#1306](https://github.com/tegojs/tego-standard/pull/1306)) (@bai.zixv)
- jsparse、jscode tooptip ([#1303](https://github.com/tegojs/tego-standard/pull/1303)) (@bai.zixv)
- 全部，更改 jsonParse 指令配置 ([#1301](https://github.com/tegojs/tego-standard/pull/1301)) (@bai.zixv)
- 重构重新提交 ([#1290](https://github.com/tegojs/tego-standard/pull/1290)) (@sealday)
- 批准，修复草稿([#1281](https://github.com/tegojs/tego-standard/pull/1281)) (@bai.zixv)
- 添加手机端审批重新申请功能 ([#1273](https://github.com/tegojs/tego-standard/pull/1273)) (@wjh)
- 批准，防止创建批准记录 ([#1272](https://github.com/tegojs/tego-standard/pull/1272)) (@bai.zixv)
- 批准，重新提交批准([#1270](https://github.com/tegojs/tego-standard/pull/1270)) (@bai.zixv)
- 重构移动组件并在表单中添加扩展集合 ([#1259](https://github.com/tegojs/tego-standard/pull/1259)) (@sealday)
- searchJump和计算器 (@sealday)
- 支持stock_v2 ([#1249](https://github.com/tegojs/tego-standard/pull/1249)) (@sealday)
- 审批编辑 (@bai.zixv)
- 优秀([#1004](https://github.com/tegojs/tego-standard/pull/1004)) (@sealday)
- 添加mobile的级联组件 ([#1221](https://github.com/tegojs/tego-standard/pull/1221)) (@wjh)
- 初始化支持通知区域 ([#1216](https://github.com/tegojs/tego-standard/pull/1216)) (@sealday)
- 支持工作流负载转储 ([#1199](https://github.com/tegojs/tego-standard/pull/1199)) (@sealday)
- 添加代码镜像 ([#1195](https://github.com/tegojs/tego-standard/pull/1195)) (@sealday)
- webhook 可以触发工作流程 ([#1193](https://github.com/tegojs/tego-standard/pull/1193)) (@sealday)
- 支持功能([#1189](https://github.com/tegojs/tego-standard/pull/1189)) (@sealday)
- 现在工作流程可以响应 ([#1186](https://github.com/tegojs/tego-standard/pull/1186)) (@sealday)
- 在使用组件道具之前使用可见 ([#1182](https://github.com/tegojs/tego-standard/pull/1182)) (@sealday)
- 快速添加支持排序 ([#1175](https://github.com/tegojs/tego-standard/pull/1175)) (@sealday)
- 支持 webhook 管理器 ([#1152](https://github.com/tegojs/tego-standard/pull/1152)) (@sealday)
- 子表单添加快速创建的折叠功能 ([#1143](https://github.com/tegojs/tego-standard/pull/1143)) (@wjh)
- 循环通知([#1138](https://github.com/tegojs/tego-standard/pull/1138)) (@sealday)
- 注意硬编码 ([#1136](https://github.com/tegojs/tego-standard/pull/1136)) (@sealday)
- 备份通知 ([#1134](https://github.com/tegojs/tego-standard/pull/1134)) (@sealday)
- 通知管理器 ([#1131](https://github.com/tegojs/tego-standard/pull/1131)) (@sealday)
- 子表格新增快速添加功能 ([#1122](https://github.com/tegojs/tego-standard/pull/1122)) (@wjh)
- 插件工作流，常规 API ([#1103](https://github.com/tegojs/tego-standard/pull/1103)) (@bai.zixv)
- 新的操作区域([#1113](https://github.com/tegojs/tego-standard/pull/1113)) (@sealday)
- 支持多个条目 ([#1104](https://github.com/tegojs/tego-standard/pull/1104)) (@sealday)
- 添加移动端选择框组件 ([#1093](https://github.com/tegojs/tego-standard/pull/1093)) (@wangjiahui)
- 插件工作流 json 解析 ([#1091](https://github.com/tegojs/tego-standard/pull/1091)) (@bai.zixv)
- 子表操作 ([#1082](https://github.com/tegojs/tego-standard/pull/1082)) (@sealday)
- 插件核心，代码字段评估 ([#1079](https://github.com/tegojs/tego-standard/pull/1079)) (@bai.zixv)
- 支持构建错误转储 ([#1069](https://github.com/tegojs/tego-standard/pull/1069)) (@sealday)
- 插件批准，注意配置选择 ([#1048](https://github.com/tegojs/tego-standard/pull/1048)) (@bai.zixv)
- 审批摘要和重构 antd 风格 ([#1036](https://github.com/tegojs/tego-standard/pull/1036)) (@bai.zixv)
- 优化过滤器表单中的复选框 ([#1024](https://github.com/tegojs/tego-standard/pull/1024)) (@sealday)
- 支持评论([#1022](https://github.com/tegojs/tego-standard/pull/1022)) (@sealday)
- 多应用程序和插件 ([#1020](https://github.com/tegojs/tego-standard/pull/1020)) (@sealday)
- 支持 mysql 作为数据源 ([#1018](https://github.com/tegojs/tego-standard/pull/1018)) (@sealday)
- 无限滚动和可链接的卡片项目 (@bai.zixv)
- 支持布局方向 (@bai.zixv)
- init 支持移动审批 ([#1002](https://github.com/tegojs/tego-standard/pull/1002)) (@bai.zixv)
- 支持新样式配置 ([#1000](https://github.com/tegojs/tego-standard/pull/1000)) (@sealday)
- 支持移动设备上的 pdf 缩放 ([#990](https://github.com/tegojs/tego-standard/pull/990)) (@sealday)
- 支持打开模式表 ([#989](https://github.com/tegojs/tego-standard/pull/989)) (@sealday)
- tachybase 图标，公式支持自动编码 ([#987](https://github.com/tegojs/tego-standard/pull/987)) (@sealday)
- fix 模版报错报错 ([#971](https://github.com/tegojs/tego-standard/pull/971)) (@hello@lv)
- 支持移动领域相关([#941](https://github.com/tegojs/tego-standard/pull/941)) (@bai.zixv)
- 支持查看合约([#947](https://github.com/tegojs/tego-standard/pull/947)) (@sealday)
- 合同日期范围 ([#939](https://github.com/tegojs/tego-standard/pull/939)) (@sealday)
- 二期调整 ([#926](https://github.com/tegojs/tego-standard/pull/926)) (@hello@lv)
- 仓库二期 ([#719](https://github.com/tegojs/tego-standard/pull/719)) (@sealday)
- 支持编辑关联表单([#920](https://github.com/tegojs/tego-standard/pull/920)) (@sealday)
- 支持默认设置项([#918](https://github.com/tegojs/tego-standard/pull/918)) (@sealday)
- 支持弹出窗口中的其他集合 ([#916](https://github.com/tegojs/tego-standard/pull/916)) close #838 (@sealday)
- 支持选项卡转储和加载 ([#915](https://github.com/tegojs/tego-standard/pull/915)) (@sealday)
- 插件租赁，支持计算税费，按类别过滤([#909](https://github.com/tegojs/tego-standard/pull/909)) (@bai.zixv)
- 合并 @hera/plugin-mobile 到 @tachybase/plugin-mobile-client close #906 ([#912](https://github.com/tegojs/tego-standard/pull/912)) (@wjh)
- 三聪头相关移动端支持逻辑 ([#798](https://github.com/tegojs/tego-standard/pull/798)) (@bai.zixv)
- 支持工作流批量 ([#858](https://github.com/tegojs/tego-standard/pull/858)) (@sealday)
- 支持虚拟编辑器 ([#894](https://github.com/tegojs/tego-standard/pull/894)) (@sealday)
- 插件核心，扩展了 calcResult 支持 jsx dayjs ([#882](https://github.com/tegojs/tego-standard/pull/882)) (@bai.zixv)
- 支持业务领域 ([#879](https://github.com/tegojs/tego-standard/pull/879)) (@sealday)
- 支持业务领域([#877](https://github.com/tegojs/tego-standard/pull/877)) (@sealday)
- 支持上下文菜单和可拖动按钮 ([#844](https://github.com/tegojs/tego-standard/pull/844)) (@sealday)
- 订单修改结算单状态未改变 close #847 ([#848](https://github.com/tegojs/tego-standard/pull/848)) (@hello@lv)
- 支持排序 m2m 和 o2m 字段 ([#768](https://github.com/tegojs/tego-standard/pull/768)) (@sealday)
- 支持日期范围字段 ([#828](https://github.com/tegojs/tego-standard/pull/828)) (@sealday)
- 提高批准率 ([#820](https://github.com/tegojs/tego-standard/pull/820)) (@sealday)
- 记录 pdf 缓存 ([#823](https://github.com/tegojs/tego-standard/pull/823)) (@sealday)
- 工作流审批组件完善 ([#673](https://github.com/tegojs/tego-standard/pull/673)) (@bai.zixv)
- 支持快速更新插件版本 ([#797](https://github.com/tegojs/tego-standard/pull/797)) (@bai.zixv)
- 初始化支持部门([#788](https://github.com/tegojs/tego-standard/pull/788)) (@sealday)
- 支持嵌入页面 ([#786](https://github.com/tegojs/tego-standard/pull/786)) (@sealday)
- 初始化外部数据源支持 ([#785](https://github.com/tegojs/tego-standard/pull/785)) (@sealday)
- 支持缓存 (@sealday)
- 支持ci发布 (@sealday)
- 支持行动 ([#758](https://github.com/tegojs/tego-standard/pull/758)) (@sealday)
- 新增mobile审批组件样式模版 close #742 ([#763](https://github.com/tegojs/tego-standard/pull/763)) (@wjh)
- 合同费用校验（无产品关联先跳过）clost #756 ([#757](https://github.com/tegojs/tego-standard/pull/757)) (@hello@lv)
- 图标搜索优化, 给选中的图标添加背景色,方便识别 ([#754](https://github.com/tegojs/tego-standard/pull/754)) (@bai.zixv)
- 将表单的布局模式,按钮设置的默认位置, 放置在右上角 (@bai.zixv)
- 支持设置显示附件数量 ([#753](https://github.com/tegojs/tego-standard/pull/753)) (@bai.zixv)
- to_char 图表时间字段时区问题 close #747 ([#750](https://github.com/tegojs/tego-standard/pull/750)) (@hello@lv)
- 图标支持快捷搜索, 悬浮提示 ([#743](https://github.com/tegojs/tego-standard/pull/743)) (@bai.zixv)
- 更改表格列宽默认值为20 ([#741](https://github.com/tegojs/tego-standard/pull/741)) (@bai.zixv)
- 更改npm包管理器默认地址, 以及 更改dump-load的file选项为必选 ([#740](https://github.com/tegojs/tego-standard/pull/740)) (@bai.zixv)
- 运输单分组计算接口 feat #726 ([#728](https://github.com/tegojs/tego-standard/pull/728)) (@hello@lv)
- 结算单预览添加订单数量字段 ([#716](https://github.com/tegojs/tego-standard/pull/716)) (@wjh)
- 移动端筛选区块二期：支持更多类型 ([#702](https://github.com/tegojs/tego-standard/pull/702)) (@wjh)
- 新命令行工具 @tachybase/cli (@sealday)
- 运输单pdf付款方公司项目显示顺序调整 feat #694 ([#695](https://github.com/tegojs/tego-standard/pull/695)) (@hello@lv)
- 支持轮播图设置和跳转 (@sealday)
- 费用范围没有考虑直发单，先简单处理掉  feat #687 ([#688](https://github.com/tegojs/tego-standard/pull/688)) (@hello@lv)
- 支持.env.local.* (@sealday)
- 初步支持审批流程 (@sealday)
- 移动端支持筛选 (@sealday)
- 显示界面支持货币取反 ([#666](https://github.com/tegojs/tego-standard/pull/666)) (@bai.jingfeng)
- 合同方案租金表添加修改校验 (@lyx)
- 合同方案租金产品校验修改，长度相同进行校验 (@lyx)
- 更新提交数据,支持增量提交 (@bai.jingfeng)
- 更新属性结构appends情况 feat #620 (@lyx)
- 更新订单分组区块，重量/金额实现方式 feat #600 ([#604](https://github.com/tegojs/tego-standard/pull/604)) (@hello@lv)
- 支持级联范围过滤 (@hello@lv)
- 优化区块添加菜单 (@sealday)
- 系统设置-交互行为优化. 系统设置区块,配置操作,提交按钮,初始化时,支持设置提交成功后的回调 (@bai.jingfeng)
- @formily/* 统一成 @nocobase/schema，清理所有的 ts build 报错 ([#566](https://github.com/tegojs/tego-standard/pull/566)) (@sealday)
- 支持 docker 构建 (@sealday)
- 添加logger debug埋点输出 feat #459 (@lyx)

### 🐛 修复

- 工作线程生产启动错误 ([#1909](https://github.com/tegojs/tego-standard/pull/1909)) (@Toby)
- 国际化 (@sealday)
- 工作线程 (@sealday)
- 管理设置布局跳转 ([#1903](https://github.com/tegojs/tego-standard/pull/1903)) (@sealday)
- 重复添加资源事件 ([#1900](https://github.com/tegojs/tego-standard/pull/1900)) (@sealday)
- 构建警告([#1899](https://github.com/tegojs/tego-standard/pull/1899)) (@sealday)
- 名称错误 (@sealday)
- 初始化应用程序未加载角色 (@sealday)
- 找不到模块 (@sealday)
- **client**: 系统设置([#1894](https://github.com/tegojs/tego-standard/pull/1894)) (@sealday)
- extern pg 不显示大写表 ([#1893](https://github.com/tegojs/tego-standard/pull/1893)) (@Toby)
- **client**: 导航错误 ([#1892](https://github.com/tegojs/tego-standard/pull/1892)) (@sealday)
- 多应用程序创建错误，需要默认预设 ([#1891](https://github.com/tegojs/tego-standard/pull/1891)) (@Toby)
- 包名错误 (@sealday)
- 模块导出 (@sealday)
- 导入错误 ([#1887](https://github.com/tegojs/tego-standard/pull/1887)) (@sealday)
- Hera hook 迁移到工作流程 ([#1882](https://github.com/tegojs/tego-standard/pull/1882)) (@wjh)
- **server**: 忽略一些加载错误 (@sealday)
- Hera hook 迁移到工作流程 ([#1875](https://github.com/tegojs/tego-standard/pull/1875)) (@wjh)
- 恢复到旧的工具提示版本 (@sealday)
- 启动后找不到数据库实例 (@sealday)
- 容器在初始化时无法加载控制器 (@sealday)
- dev 使用相对路径以便于复制 (@sealday)
- 更改 tachybase 的链接 (@sealday)
- 当 Hera 未加载时，Web 服务不会加载 ([#1876](https://github.com/tegojs/tego-standard/pull/1876)) (@sealday)
- 版本检查 (@sealday)
- 历史节点 ([#1872](https://github.com/tegojs/tego-standard/pull/1872)) (@bai.zixv)
- **cloud-component**: 云组件和事件源之间的架构冲突问题 ([#1870](https://github.com/tegojs/tego-standard/pull/1870)) (@sealday)
- 历史节点 ([#1868](https://github.com/tegojs/tego-standard/pull/1868)) (@bai.zixv)
- Hera hook 迁移到工作流程 ([#1862](https://github.com/tegojs/tego-standard/pull/1862)) (@wjh)
- **department**: 部门显示所有成员错误，无法从角色中删除部门 ([#1860](https://github.com/tegojs/tego-standard/pull/1860)) (@Toby)
- Hera 前端组件迁移到云组件 ([#1858](https://github.com/tegojs/tego-standard/pull/1858)) (@wjh)
- Hera 自定义组件迁移到云组件 ([#1853](https://github.com/tegojs/tego-standard/pull/1853)) (@wjh)
- **cloud-component**: 开发时加载包 ([#1854](https://github.com/tegojs/tego-standard/pull/1854)) (@sealday)
- **client**: 递归组件只显示最里面的工具栏 (@sealday)
- **cloud-component**: 无法加载备忘录功能 ([#1850](https://github.com/tegojs/tego-standard/pull/1850)) (@sealday)
- 云组件启用错误 ([#1847](https://github.com/tegojs/tego-standard/pull/1847)) (@Toby)
- 看板 (@sealday)
- **cloud-component**: 立即生效 (@sealday)
- 云组件在表中工作 (@sealday)
- 新型工具栏的可设计工作([#1846](https://github.com/tegojs/tego-standard/pull/1846)) (@sealday)
- **cloud-component**: 身份验证错误 ([#1841](https://github.com/tegojs/tego-standard/pull/1841)) (@sealday)
- **approval**: 模糊搜索参数错误 ([#1840](https://github.com/tegojs/tego-standard/pull/1840)) (@bai.zixv)
- **client**: 显示重复创建成功消息 ([#1831](https://github.com/tegojs/tego-standard/pull/1831)) (@fanyukun)
- 添加记录 is_end 字段 ([#1833](https://github.com/tegojs/tego-standard/pull/1833)) (@wjh)
- **export**: 查找之前预计数 ([#1832](https://github.com/tegojs/tego-standard/pull/1832)) (@Toby)
- **collection-manager**: 导入表不再导入类别，导入失败也不会刷新页面 ([#1830](https://github.com/tegojs/tego-standard/pull/1830)) (@Toby)
- **acl**: 消息：ACL 错误，多应用程序应向登录授予“列表”权限 ([#1826](https://github.com/tegojs/tego-standard/pull/1826)) (@Toby)
- 模板仅获取所有者或管理员集 ([#1824](https://github.com/tegojs/tego-standard/pull/1824)) (@Toby)
- 结算单不触发凭证自动更新([#1820](https://github.com/tegojs/tego-standard/pull/1820)) (@wjh)
- acl [查看、更新、销毁] 检查包含许多包含导致 cpu 崩溃 ([#1817](https://github.com/tegojs/tego-standard/pull/1817)) (@Toby)
- 只读错误 ([#1812](https://github.com/tegojs/tego-standard/pull/1812)) (@bai.zixv)
- pdf 记录器 ([#1811](https://github.com/tegojs/tego-standard/pull/1811)) (@sealday)
- 恢复 mako 默认值 ([#1805](https://github.com/tegojs/tego-standard/pull/1805)) (@sealday)
- 唯一密钥approvalProvider ([#1800](https://github.com/tegojs/tego-standard/pull/1800)) (@bai.zixv)
- 调整 SVG 组件 ([#1799](https://github.com/tegojs/tego-standard/pull/1799)) (@wjh)
- 链接规则导致多次请求 ([#1792](https://github.com/tegojs/tego-standard/pull/1792)) (@bai.zixv)
- **approval**: 批准 ApprovalBlock.Launch.Application ([#1788](https://github.com/tegojs/tego-standard/pull/1788)) (@bai.zixv)
- moudle pdf 构建 ([#1787](https://github.com/tegojs/tego-standard/pull/1787)) (@sealday)
- 工作流审批移动插件删除 ([#1782](https://github.com/tegojs/tego-standard/pull/1782)) (@sealday)
- **approval**: 翻译命名空间 ([#1780](https://github.com/tegojs/tego-standard/pull/1780)) (@bai.zixv)
- 工作流程查看历史节点并配置和添加类别键 ([#1776](https://github.com/tegojs/tego-standard/pull/1776)) (@wjh)
- 模块 i18n ([#1770](https://github.com/tegojs/tego-standard/pull/1770)) (@sealday)
- **client**: 滚动 ([#1771](https://github.com/tegojs/tego-standard/pull/1771)) (@bai.zixv)
- 模块 pdf 和事件源应默认启用 ([#1767](https://github.com/tegojs/tego-standard/pull/1767)) (@sealday)
- 相同的 auth public 不能被登录覆盖([#1764](https://github.com/tegojs/tego-standard/pull/1764)) (@Toby)
- 结算单费用计算和 PDF 视图 ([#1763](https://github.com/tegojs/tego-standard/pull/1763)) (@wjh)
- **approval**: useSubmit 表单状态已修复 ([#1762](https://github.com/tegojs/tego-standard/pull/1762)) (@bai.zixv)
- 控制器初始化失败 ([#1758](https://github.com/tegojs/tego-standard/pull/1758)) (@sealday)
- getUserInfo 显示绑定昵称，限制登录超时 (@Toby)
- 代理端口失败 (@sealday)
- 移动标签搜索组件的日期适配 ([#1746](https://github.com/tegojs/tego-standard/pull/1746)) (@wjh)
- pdf-viewer 可在 PC 中滚动并重构 mobile-provider ([#1739](https://github.com/tegojs/tego-standard/pull/1739)) (@sealday)
- useTranslation 时出现类型错误 ([#1736](https://github.com/tegojs/tego-standard/pull/1736)) (@sealday)
- umi 模块查找失败 ([#1731](https://github.com/tegojs/tego-standard/pull/1731)) (@sealday)
- 忽略租赁升级错误 ([#1730](https://github.com/tegojs/tego-standard/pull/1730)) (@sealday)
- 修改结算单关联赔偿支持订单金额 ([#1727](https://github.com/tegojs/tego-standard/pull/1727)) (@wjh)
- 向上移动时不要更改工作流节点键 ([#1728](https://github.com/tegojs/tego-standard/pull/1728)) (@sealday)
- 工作流程按类型保存状态 ([#1726](https://github.com/tegojs/tego-standard/pull/1726)) (@sealday)
- cli 和 docker 文件路径错误 ([#1722](https://github.com/tegojs/tego-standard/pull/1722)) (@Toby)
- **approval**: 修复审批显示金额错误 (@bai.zixv)
- 视口，元缩放，1.0 ([#1713](https://github.com/tegojs/tego-standard/pull/1713)) (@bai.zixv)
- **approval**: 当某些状态发生变化时禁止触发工作流程 ([#1709](https://github.com/tegojs/tego-standard/pull/1709)) (@bai.zixv)
- 云组件现在可以在开发和生产环境中运行 ([#1702](https://github.com/tegojs/tego-standard/pull/1702)) (@sealday)
- **page-tab**: 关闭标签上的 stopPropagation ([#1700](https://github.com/tegojs/tego-standard/pull/1700)) (@bai.zixv)
- 快速入门([#1696](https://github.com/tegojs/tego-standard/pull/1696)) (@sealday)
- 完善欢迎卡片 ([#1695](https://github.com/tegojs/tego-standard/pull/1695)) (@bai.zixv)
- 修复结算单最短租期显示 ([#1691](https://github.com/tegojs/tego-standard/pull/1691)) (@wjh)
- 工作流内嵌弹窗样式问题 ([#1687](https://github.com/tegojs/tego-standard/pull/1687)) (@wjh)
- 切换到其他选项卡后选项卡面板重置 ([#1690](https://github.com/tegojs/tego-standard/pull/1690)) (@sealday)
- docker 入口点 ([#1685](https://github.com/tegojs/tego-standard/pull/1685)) (@sealday)
- 哨兵路径错误 ([#1682](https://github.com/tegojs/tego-standard/pull/1682)) (@sealday)
- pdf dist 文件 ([#1679](https://github.com/tegojs/tego-standard/pull/1679)) (@sealday)
- **approval**: 批准待办事项显示流程组件错误 ([#1674](https://github.com/tegojs/tego-standard/pull/1674)) (@bai.zixv)
- 图迁移 ([#1675](https://github.com/tegojs/tego-standard/pull/1675)) (@sealday)
- 操作表翻译 ([#1673](https://github.com/tegojs/tego-standard/pull/1673)) (@sealday)
- 将 Excel 导出和日期格式限制为带有客户端时区的字符串 ([#1661](https://github.com/tegojs/tego-standard/pull/1661)) (@Toby)
- 修改下拉框设置默认值不生效 ([#1662](https://github.com/tegojs/tego-standard/pull/1662)) (@wjh)
- **tb**: 修复平板设备过于缩小问题 ([#1655](https://github.com/tegojs/tego-standard/pull/1655)) (@bai.zixv)
- 修复工作流审批节点保存报错 ([#1653](https://github.com/tegojs/tego-standard/pull/1653)) (@wjh)
- **client**: 子菜单显示空标签 ([#1652](https://github.com/tegojs/tego-standard/pull/1652)) (@sealday)
- 添加重复的插件 ([#1642](https://github.com/tegojs/tego-standard/pull/1642)) (@sealday)
- 修改添加车辆字符验证 ([#1631](https://github.com/tegojs/tego-standard/pull/1631)) (@wjh)
- **remix**: 构建错误([#1629](https://github.com/tegojs/tego-standard/pull/1629)) (@sealday)
- 插件数据可视化缺少时间戳格式功能 #1616 ([#1625](https://github.com/tegojs/tego-standard/pull/1625)) (@Toby)
- **red-node**: 红色节点构建失败 ([#1622](https://github.com/tegojs/tego-standard/pull/1622)) (@sealday)
- **core**: 修复类型错误 ([#1620](https://github.com/tegojs/tego-standard/pull/1620)) (@bai.zixv)
- **tb**: 附件的宽度适配调整 ([#1619](https://github.com/tegojs/tego-standard/pull/1619)) (@bai.zixv)
- **tb**: 替换开源pdf附件组件 & feat(tb):附件支持execl预览功能 ([#1612](https://github.com/tegojs/tego-standard/pull/1612)) (@bai.zixv)
- **审批**: 审批修复, 摘要宽度, 状态更正 #1597 & fix(审批): 审批修复, 必填项没填禁止发起 ([#1613](https://github.com/tegojs/tego-standard/pull/1613)) (@bai.zixv)
- 应用程序升级不应覆盖插件的激活状态 ([#1610](https://github.com/tegojs/tego-standard/pull/1610)) (@sealday)
- **auth**: 修复重置数据问题 ([#1598](https://github.com/tegojs/tego-standard/pull/1598)) (@bai.zixv)
- 审批摘要, 文案过长时候要换行(更换一行显示) ([#1590](https://github.com/tegojs/tego-standard/pull/1590)) (@wjh)
- **notification**: 移动浏览器不支持 ([#1588](https://github.com/tegojs/tego-standard/pull/1588)) (@sealday)
- **审批**: 审批摘要, 文案过长时候要换行 ([#1587](https://github.com/tegojs/tego-standard/pull/1587)) (@wjh)
- 修复对账单无法重新结算 ([#1586](https://github.com/tegojs/tego-standard/pull/1586)) (@wjh)
- **数据表**: 树数据表-级联修复,修复级联选择编辑无显示 ([#1583](https://github.com/tegojs/tego-standard/pull/1583)) (@wjh)
- **workflow**: 数据表触发时机为更新数据的黑白名单机制修改 ([#1585](https://github.com/tegojs/tego-standard/pull/1585)) (@Toby)
- 审批创建日期复制后重新提交还是之前的日期&审批移动端始终将创建日期排在第一个(取审批的创建日期) ([#1581](https://github.com/tegojs/tego-standard/pull/1581)) (@wjh)
- 修复项目库存计算无法完结 ([#1582](https://github.com/tegojs/tego-standard/pull/1582)) (@wjh)
- 移动端审批发起添加默认筛选条件 ([#1576](https://github.com/tegojs/tego-standard/pull/1576)) (@wjh)
- 完善右键全屏 ([#1572](https://github.com/tegojs/tego-standard/pull/1572)) (@wjh)
- **移动端-框架**: 附件删除(删除不掉) ([#1574](https://github.com/tegojs/tego-standard/pull/1574)) (@wjh)
- 修复有互相引用的字段导入问题 ([#1568](https://github.com/tegojs/tego-standard/pull/1568)) (@Toby)
- **acl**: 创建后同步角色策略 ([#1565](https://github.com/tegojs/tego-standard/pull/1565)) (@sealday)
- 优化附件显示 ([#1545](https://github.com/tegojs/tego-standard/pull/1545)) (@wjh)
- **workflow**: 移除废弃文案 ([#1562](https://github.com/tegojs/tego-standard/pull/1562)) (@bai.zixv)
- **workflow**: 添加提交按钮允许绑定通用工作流并触发 ([#1560](https://github.com/tegojs/tego-standard/pull/1560)) (@bai.zixv)
- 主题错误，关闭 #1557 ([#1558](https://github.com/tegojs/tego-standard/pull/1558)) (@sealday)
- **departments**: 切换部门,自动刷新获取当前用户列表 ([#1549](https://github.com/tegojs/tego-standard/pull/1549)) (@bai.zixv)
- **approval**: 容错处理,审批权限设置错误后,重新设置权限时触发的报错 ([#1536](https://github.com/tegojs/tego-standard/pull/1536)) (@bai.zixv)
- **approval**: 审批-发起, 去除硬编码 & 给审批-发起,添加默认的筛选条件 ([#1544](https://github.com/tegojs/tego-standard/pull/1544)) (@bai.zixv)
- 主题修改导航间距不生效 ([#1548](https://github.com/tegojs/tego-standard/pull/1548)) (@wjh)
- 完善个人设置界面 ([#1542](https://github.com/tegojs/tego-standard/pull/1542)) (@wjh)
- 筛选表单关联字段添加运算符 ([#1537](https://github.com/tegojs/tego-standard/pull/1537)) (@wjh)
- 退出全屏按钮适配导航 ([#1541](https://github.com/tegojs/tego-standard/pull/1541)) (@wjh)
- 在 Linux 中运行 ([#1538](https://github.com/tegojs/tego-standard/pull/1538)) (@TomyJan)
- windows环境无法运行 ([#1535](https://github.com/tegojs/tego-standard/pull/1535)) (@Toby)
- **department**: 审批三期 ([#1507](https://github.com/tegojs/tego-standard/pull/1507)) (@bai.zixv)
- **dianziqian**: 处理url ([#1531](https://github.com/tegojs/tego-standard/pull/1531)) (@wanggang)
- **dianziqian**: 外部请求不带token ([#1529](https://github.com/tegojs/tego-standard/pull/1529)) (@wanggang)
- **plugin-dingtalk, plugin-wechat-auth, plugin-work-wechat**: oauth 重定向 url ([#1526](https://github.com/tegojs/tego-standard/pull/1526)) (@TomyJan)
- **multi-app-manager**: 重复判断 ([#1522](https://github.com/tegojs/tego-standard/pull/1522)) (@TomyJan)
- 合同添加甲乙字段并同步对账单 ([#1505](https://github.com/tegojs/tego-standard/pull/1505)) (@wjh)
- 修复图表的添加到检查列表无效 ([#1513](https://github.com/tegojs/tego-standard/pull/1513)) (@wjh)
- 关联表格添加无法使用引用模版 ([#1510](https://github.com/tegojs/tego-standard/pull/1510)) (@wjh)
- 修复替身合同结算实际重量不对 ([#1509](https://github.com/tegojs/tego-standard/pull/1509)) (@wjh)
- 备案号添加跳转链接 ([#1508](https://github.com/tegojs/tego-standard/pull/1508)) (@wjh)
- 审批重新提交&自定义筛选翻译 ([#1502](https://github.com/tegojs/tego-standard/pull/1502)) (@wjh)
- 多应用预览跳转路径不对 ([#1501](https://github.com/tegojs/tego-standard/pull/1501)) (@wjh)
- **migration**: 修复路径 ([#1496](https://github.com/tegojs/tego-standard/pull/1496)) (@bai.zixv)
- 更新首页内容 ([#1495](https://github.com/tegojs/tego-standard/pull/1495)) (@wjh)
- 修改记录单关联项目没有符合预期 ([#1490](https://github.com/tegojs/tego-standard/pull/1490)) (@wjh)
- **app-supervisor**: 应用程序初始化中的错误逻辑 ([#1489](https://github.com/tegojs/tego-standard/pull/1489)) (@TomyJan)
- 修复结算单无关联费用适应替身合同 ([#1487](https://github.com/tegojs/tego-standard/pull/1487)) (@wjh)
- 修复替身合同计算有问题 ([#1484](https://github.com/tegojs/tego-standard/pull/1484)) (@wjh)
- **grid**: 拖动山口 ([#1478](https://github.com/tegojs/tego-standard/pull/1478)) (@bai.zixv)
- 修复表格复制和直发单修改没有分组项 ([#1479](https://github.com/tegojs/tego-standard/pull/1479)) (@wjh)
- 修复结算单查看没有考虑替身合同问题 ([#1475](https://github.com/tegojs/tego-standard/pull/1475)) (@wjh)
- 添加结账阶段 ([#1464](https://github.com/tegojs/tego-standard/pull/1464)) (@sealday)
- 修复直发单生成租赁单时维修赔偿数据没有更新 ([#1459](https://github.com/tegojs/tego-standard/pull/1459)) (@wjh)
- hera/core组件迁移到core ([#1453](https://github.com/tegojs/tego-standard/pull/1453)) (@wjh)
- **telemetry**: 添加日志传输以避免警告 ([#1451](https://github.com/tegojs/tego-standard/pull/1451)) (@TomyJan)
- **telemetry**: 仅在“stop”中关闭遥测([#1454](https://github.com/tegojs/tego-standard/pull/1454)) (@TomyJan)
- 将自定义筛选字段移到core/client ([#1438](https://github.com/tegojs/tego-standard/pull/1438)) (@wjh)
- 记录器应该登录文件默认值 ([#1429](https://github.com/tegojs/tego-standard/pull/1429)) (@sealday)
- 修改导航栏顶部菜单显示样式 ([#1425](https://github.com/tegojs/tego-standard/pull/1425)) (@wjh)
- **approval**: 添加审批触发器设计器 && 修复（审批-移动）-更改 Carboncopy 列表中心 ([#1420](https://github.com/tegojs/tego-standard/pull/1420)) (@bai.zixv)
- 捕手 ([#1424](https://github.com/tegojs/tego-standard/pull/1424)) (@sealday)
- 原始 url 包含空字符串 ([#1414](https://github.com/tegojs/tego-standard/pull/1414)) (@sealday)
- 工作流触发 ([#1413](https://github.com/tegojs/tego-standard/pull/1413)) (@sealday)
- 工作流编辑器支持dayjs ([#1407](https://github.com/tegojs/tego-standard/pull/1407)) (@wjh)
- 删除 koa-router ([#1411](https://github.com/tegojs/tego-standard/pull/1411)) (@yoona)
- **approval**: 临时固定批准表单值([#1401](https://github.com/tegojs/tego-standard/pull/1401)) (@bai.zixv)
- 摩纳哥要求 ([#1404](https://github.com/tegojs/tego-standard/pull/1404)) (@sealday)
- **approval**: 更改组件寄存器([#1399](https://github.com/tegojs/tego-standard/pull/1399)) (@bai.zixv)
- **approval**: 修复了 createAt 排序 ([#1396](https://github.com/tegojs/tego-standard/pull/1396)) (@bai.zixv)
- 批量生成pdf且可下载pdf ([#1394](https://github.com/tegojs/tego-standard/pull/1394)) (@yoona)
- **work-wechat**: 缺少 deps @tachybase/database ([#1392](https://github.com/tegojs/tego-standard/pull/1392)) (@sealday)
- 审批移动、日期选择器 ([#1391](https://github.com/tegojs/tego-standard/pull/1391)) (@bai.zixv)
- 设置移动端时间组件默认值生效 ([#1388](https://github.com/tegojs/tego-standard/pull/1388)) (@wjh)
- 未添加微信插件 ([#1389](https://github.com/tegojs/tego-standard/pull/1389)) (@sealday)
- 现在可以更改工作流同步状态（使用风险自负），代码镜像现在支持默认值 ([#1387](https://github.com/tegojs/tego-standard/pull/1387)) (@sealday)
- jscode，重构([#1379](https://github.com/tegojs/tego-standard/pull/1379)) (@bai.zixv)
- 修改移动端审批待办没有数据 ([#1376](https://github.com/tegojs/tego-standard/pull/1376)) (@wjh)
- 审批移动，显示任务节点和审批，更新快照 ([#1367](https://github.com/tegojs/tego-standard/pull/1367)) (@bai.zixv)
- 移动端我的发起和抄送没有数据 ([#1368](https://github.com/tegojs/tego-standard/pull/1368)) (@wjh)
- 添加默认扩展 ui 路径 ([#1371](https://github.com/tegojs/tego-standard/pull/1371)) (@sealday)
- 更新角色迁移 ([#1366](https://github.com/tegojs/tego-standard/pull/1366)) (@sealday)
- 表，排序 ([#1361](https://github.com/tegojs/tego-standard/pull/1361)) (@bai.zixv)
- 修改移动端重新提交后表单状态 ([#1357](https://github.com/tegojs/tego-standard/pull/1357)) (@wjh)
- 批准，固定排序 ([#1356](https://github.com/tegojs/tego-standard/pull/1356)) (@bai.zixv)
- docker 构建 ([#1355](https://github.com/tegojs/tego-standard/pull/1355)) (@sealday)
- 码头工人 ([#1354](https://github.com/tegojs/tego-standard/pull/1354)) (@sealday)
- 批准，显示流程和壮举：批准，lastNode ([#1343](https://github.com/tegojs/tego-standard/pull/1343)) (@bai.zixv)
- 使用 tachbase/client 的 dingtalk 服务器 ([#1342](https://github.com/tegojs/tego-standard/pull/1342)) (@sealday)
- 同步移动端审批抄送 ([#1339](https://github.com/tegojs/tego-standard/pull/1339)) (@wjh)
- 部门 ([#1336](https://github.com/tegojs/tego-standard/pull/1336)) (@sealday)
- 修改主题出错 ([#1327](https://github.com/tegojs/tego-standard/pull/1327)) (@wjh)
- 保存区块模版时操作位置错误 ([#1329](https://github.com/tegojs/tego-standard/pull/1329)) (@wjh)
- 令牌，固定逻辑 ([#1321](https://github.com/tegojs/tego-standard/pull/1321)) (@bai.zixv)
- 数据映射，修复无数据源 ([#1315](https://github.com/tegojs/tego-standard/pull/1315)) (@bai.zixv)
- modal.confirm 不是函数 ([#1308](https://github.com/tegojs/tego-standard/pull/1308)) (@sealday)
- js 解析 ([#1298](https://github.com/tegojs/tego-standard/pull/1298)) (@sealday)
- 修改手机端审批再发起功能 ([#1295](https://github.com/tegojs/tego-standard/pull/1295)) (@wjh)
- 提交([#1294](https://github.com/tegojs/tego-standard/pull/1294)) (@sealday)
- 批准提交([#1292](https://github.com/tegojs/tego-standard/pull/1292)) (@sealday)
- 修复手机端审批无法通过和状态没有显示 ([#1287](https://github.com/tegojs/tego-standard/pull/1287)) (@wjh)
- 修改手机端我的发起页面搜索没反应 ([#1280](https://github.com/tegojs/tego-standard/pull/1280)) (@wjh)
- 批准，jsonata 修复 ([#1277](https://github.com/tegojs/tego-standard/pull/1277)) (@bai.zixv)
- 批准、批准执行快照 ([#1274](https://github.com/tegojs/tego-standard/pull/1274)) (@bai.zixv)
- 批准，修复应用按钮错误([#1271](https://github.com/tegojs/tego-standard/pull/1271)) (@bai.zixv)
- 修复图表页面设置分页无效 ([#1257](https://github.com/tegojs/tego-standard/pull/1257)) (@wjh)
- 修复表格搜索不能用,表单删除样式显示 ([#1256](https://github.com/tegojs/tego-standard/pull/1256)) (@wjh)
- 修复改变数据范围后显示字段会重置 ([#1258](https://github.com/tegojs/tego-standard/pull/1258)) (@wjh)
- 审批, 自动刷新机制和撤回后更改子表格关联字段 ([#1260](https://github.com/tegojs/tego-standard/pull/1260)) (@bai.zixv)
- 筛选区块支持关联项直接添加 ([#1255](https://github.com/tegojs/tego-standard/pull/1255)) (@wjh)
- 修复图表筛选区块字段支持排序 ([#1252](https://github.com/tegojs/tego-standard/pull/1252)) (@wjh)
- 发票，租赁 sql 发票税值 ([#1250](https://github.com/tegojs/tego-standard/pull/1250)) (@bai.zixv)
- 修复汇总区块如果是最后一个删除，添加区块消失 #1243 (@wjh)
- 完善手机端审批功能 ([#1247](https://github.com/tegojs/tego-standard/pull/1247)) (@wjh)
- 请求用户 ID ([#1227](https://github.com/tegojs/tego-standard/pull/1227)) (@sealday)
- 完善mobile级联组件的地区功能和只读样式 ([#1226](https://github.com/tegojs/tego-standard/pull/1226)) (@wjh)
- 许可([#1224](https://github.com/tegojs/tego-standard/pull/1224)) (@sealday)
- 工作流 http 触发器 ([#1222](https://github.com/tegojs/tego-standard/pull/1222)) (@sealday)
- 插件依赖 ([#1218](https://github.com/tegojs/tego-standard/pull/1218)) (@sealday)
- 工作流程/地图的国际化 ([#1210](https://github.com/tegojs/tego-standard/pull/1210)) (@sealday)
- 部门([#1203](https://github.com/tegojs/tego-standard/pull/1203)) (@sealday)
- 修复表格在没有拖拽排序下点击分页没有排序字段 ([#1202](https://github.com/tegojs/tego-standard/pull/1202)) (@wjh)
- api 触发两次 ([#1192](https://github.com/tegojs/tego-standard/pull/1192)) (@sealday)
- 行动区 ([#1188](https://github.com/tegojs/tego-standard/pull/1188)) (@sealday)
- 工作流程执行不显示和格式化代码 ([#1184](https://github.com/tegojs/tego-standard/pull/1184)) (@sealday)
- 修改子表格快捷添加的样式，审批表格的字段显示顺序，表格分页排序问题 ([#1183](https://github.com/tegojs/tego-standard/pull/1183)) (@wjh)
- 快速编辑样式 ([#1177](https://github.com/tegojs/tego-standard/pull/1177)) (@sealday)
- 快速编辑 ([#1176](https://github.com/tegojs/tego-standard/pull/1176)) (@sealday)
- 移动用户界面链接 ([#1173](https://github.com/tegojs/tego-standard/pull/1173)) (@sealday)
- 集合未定义 ([#1169](https://github.com/tegojs/tego-standard/pull/1169)) (@sealday)
- 可变样式 ([#1167](https://github.com/tegojs/tego-standard/pull/1167)) (@sealday)
- 修复移动端审批查看人名显示undefined，抄送人列表名字不正确 ([#1164](https://github.com/tegojs/tego-standard/pull/1164)) (@wjh)
- 提交工作流错误 ([#1163](https://github.com/tegojs/tego-standard/pull/1163)) 修复 #1162 (@sealday)
- 主题配置 ([#1161](https://github.com/tegojs/tego-standard/pull/1161)) (@sealday)
- 修复移动端快速添加功能 ([#1153](https://github.com/tegojs/tego-standard/pull/1153)) (@wjh)
- 修改结算单其他费用的计算逻辑 ([#1146](https://github.com/tegojs/tego-standard/pull/1146)) (@wjh)
- 修改移动端抄送我的配置和界面 ([#1142](https://github.com/tegojs/tego-standard/pull/1142)) (@wangjiahui)
- 修复表单快速添加和弹窗添加功能 ([#1141](https://github.com/tegojs/tego-standard/pull/1141)) (@wjh)
- notifiedPerson 长度 ([#1137](https://github.com/tegojs/tego-standard/pull/1137)) (@sealday)
- 修改子表格快速添加搜索bug,添加分类的所有选项 ([#1129](https://github.com/tegojs/tego-standard/pull/1129)) (@wjh)
- 子表搜索 ([#1124](https://github.com/tegojs/tego-standard/pull/1124)) (@sealday)
- 子表单到子表单 ([#1121](https://github.com/tegojs/tego-standard/pull/1121)) (@sealday)
- 弹出记录 ([#1116](https://github.com/tegojs/tego-standard/pull/1116)) (@sealday)
- 修改弹窗中的模版行为按钮固定在上面 ([#1114](https://github.com/tegojs/tego-standard/pull/1114)) (@wjh)
- 获取应用程序信息 ([#1107](https://github.com/tegojs/tego-standard/pull/1107)) (@sealday)
- 修改移动端下拉框适配自定义数据选择 ([#1102](https://github.com/tegojs/tego-standard/pull/1102)) (@wjh)
- 表格附加 ([#1099](https://github.com/tegojs/tego-standard/pull/1099)) (@sealday)
- 插件工作流程，从节点导入指令 ([#1095](https://github.com/tegojs/tego-standard/pull/1095)) (@bai.zixv)
- 工作流程插件 ([#1094](https://github.com/tegojs/tego-standard/pull/1094)) (@sealday)
- 修改标签没有对应颜色，审批页面没有显示正确的创建人名称 ([#1090](https://github.com/tegojs/tego-standard/pull/1090)) (@wjh)
- 在初始化组块之前使用 ([#1085](https://github.com/tegojs/tego-standard/pull/1085)) (@sealday)
- 设计菜单不显示 ([#1083](https://github.com/tegojs/tego-standard/pull/1083)) (@sealday)
- 修复审批页面标签不是翻译后的 ([#1080](https://github.com/tegojs/tego-standard/pull/1080)) (@wjh)
- 修改执行处理没有显示数据，把审核内容和流程放在同一页面 ([#1077](https://github.com/tegojs/tego-standard/pull/1077)) (@wangjiahui)
- 代码字段 ([#1071](https://github.com/tegojs/tego-standard/pull/1071)) (@bai.zixv)
- 模板加载 ([#1072](https://github.com/tegojs/tego-standard/pull/1072)) 关闭 #626 (@sealday)
- 修复手机端我的发起出错 ([#1073](https://github.com/tegojs/tego-standard/pull/1073)) (@wjh)
- 显示流量计数 ([#1062](https://github.com/tegojs/tego-standard/pull/1062)) (@bai.zixv)
- 所需的表 ([#1063](https://github.com/tegojs/tego-standard/pull/1063)) (@sealday)
- 合并开发错误 ([#1060](https://github.com/tegojs/tego-standard/pull/1060)) (@bai.zixv)
- 条目 ([#1058](https://github.com/tegojs/tego-standard/pull/1058)) (@sealday)
- 完善审批工作流界面配置 ([#1057](https://github.com/tegojs/tego-standard/pull/1057)) (@wjh)
- 移动客户端，showCount ([#1055](https://github.com/tegojs/tego-standard/pull/1055)) (@bai.zixv)
- 优化移动端没有页面的效果 ([#1053](https://github.com/tegojs/tego-standard/pull/1053)) (@wjh)
- 修复手机端表单使用相对应的组件 ([#1054](https://github.com/tegojs/tego-standard/pull/1054)) (@wjh)
- 完善审批摘要内容 ([#1051](https://github.com/tegojs/tego-standard/pull/1051)) (@wjh)
- 锁 ([#1052](https://github.com/tegojs/tego-standard/pull/1052)) (@sealday)
- 当前用户风格错误 ([#1049](https://github.com/tegojs/tego-standard/pull/1049)) (@sealday)
- props disabled ([#1047](https://github.com/tegojs/tego-standard/pull/1047)) (@sealday)
- 完善移动端审批组件 ([#1042](https://github.com/tegojs/tego-standard/pull/1042)) (@wjh)
- 单击时应获取批量更新密钥([#1040](https://github.com/tegojs/tego-standard/pull/1040)) (@sealday)
- 插件批准，套件添加 ([#1038](https://github.com/tegojs/tego-standard/pull/1038)) (@bai.zixv)
- 重复的设计师设置项目 ([#1028](https://github.com/tegojs/tego-standard/pull/1028)) (@sealday)
- 评论插件 ([#1023](https://github.com/tegojs/tego-standard/pull/1023)) (@sealday)
- 核心，布局方向([#1013](https://github.com/tegojs/tego-standard/pull/1013)) (@bai.zixv)
- 主页 ([#1011](https://github.com/tegojs/tego-standard/pull/1011)) (@sealday)
- 修改结算单人工录入计算逻辑 ([#1007](https://github.com/tegojs/tego-standard/pull/1007)) (@wjh)
- 插件设置使用相同的名称 ([#1005](https://github.com/tegojs/tego-standard/pull/1005)) (@sealday)
- 修改结算单报错问题 ([#998](https://github.com/tegojs/tego-standard/pull/998)) (@wjh)
- 修复异常死循环问题 ([#991](https://github.com/tegojs/tego-standard/pull/991)) (@sealday)
- 修复不稳定的更新状态和错误的 preset ([#985](https://github.com/tegojs/tego-standard/pull/985)) (@sealday)
- 统一注释改成备注合并 ([#977](https://github.com/tegojs/tego-standard/pull/977)) (@wjh)
- 修改侧边栏滑动超出后出现 ([#966](https://github.com/tegojs/tego-standard/pull/966)) (@wjh)
- 修复自定义标题标签不显示 ([#963](https://github.com/tegojs/tego-standard/pull/963)) (@wjh)
- 修复多对多筛选中间表无效 ([#962](https://github.com/tegojs/tego-standard/pull/962)) (@wjh)
- 修改录单的维修赔偿级联点击能显示名称，修改级联组价查看显示标题 ([#958](https://github.com/tegojs/tego-standard/pull/958)) (@wjh)
- plugin-mobile-client，支持设置数据范围 ([#956](https://github.com/tegojs/tego-standard/pull/956)) (@bai.zixv)
- 修改合同筛选方案明细的条件 ([#950](https://github.com/tegojs/tego-standard/pull/950)) (@wjh)
- 修改组件创建树形结构时默认为级联组件 ([#948](https://github.com/tegojs/tego-standard/pull/948)) (@wjh)
- 查看合同 ([#949](https://github.com/tegojs/tego-standard/pull/949)) (@sealday)
- 修改录单时产品没有合同显示全部 ([#946](https://github.com/tegojs/tego-standard/pull/946)) (@wjh)
- 修改自定义标题标签显示 ([#943](https://github.com/tegojs/tego-standard/pull/943)) (@wjh)
- 处理调拨单类型显示不正确问题 (@hello@lv)
- 级联滤波器 ([#940](https://github.com/tegojs/tego-standard/pull/940)) (@sealday)
- 插件核心，集合兼容性 ([#935](https://github.com/tegojs/tego-standard/pull/935)) (@bai.zixv)
- 出入库查询视图 ([#936](https://github.com/tegojs/tego-standard/pull/936)) (@hello@lv)
- 预设错误 ([#930](https://github.com/tegojs/tego-standard/pull/930)) (@sealday)
- 移动翻译 ([#929](https://github.com/tegojs/tego-standard/pull/929)) (@sealday)
- 移动卷轴 ([#928](https://github.com/tegojs/tego-standard/pull/928)) (@bai.zixv)
- 修改侧边菜单没有滑动效果 ([#925](https://github.com/tegojs/tego-standard/pull/925)) (@wjh)
- 抽屉子表中的当前对象 ([#924](https://github.com/tegojs/tego-standard/pull/924)) (@sealday)
- 修改汇总区块兼容视图没有字段的情况 ([#923](https://github.com/tegojs/tego-standard/pull/923)) (@wjh)
- 加载架构不起作用 ([#919](https://github.com/tegojs/tego-standard/pull/919)) (@sealday)
- 插件核心，CalcResult，修复childrenType ([#888](https://github.com/tegojs/tego-standard/pull/888)) (@bai.zixv)
- 修改级联选择在置空后没有及时清除表单内容 close #831 ([#866](https://github.com/tegojs/tego-standard/pull/866)) (@wjh)
- 插件批准，触发数据 ([#861](https://github.com/tegojs/tego-standard/pull/861)) (@bai.zixv)
- sql，view_invoices_tax，将结果月份转换为 utc ([#859](https://github.com/tegojs/tego-standard/pull/859)) (@bai.zixv)
- 插件租赁、view_invoices_taxs-sql、日期区域设置上海 ([#849](https://github.com/tegojs/tego-standard/pull/849)) (@bai.zixv)
- **plugin-workflow-manual**: 扁平化受让人，受让人解析错误 ([#837](https://github.com/tegojs/tego-standard/pull/837)) (@bai.zixv)
- 插件批准、提交批准或拒绝失败 ([#835](https://github.com/tegojs/tego-standard/pull/835)) (@bai.zixv)
- 筛选结算单订单类型只有租赁类型 ([#829](https://github.com/tegojs/tego-standard/pull/829)) (@wjh)
- 旧版本获取流 ([#825](https://github.com/tegojs/tego-standard/pull/825)) (@sealday)
- 设置块无法搜索项目 ([#814](https://github.com/tegojs/tego-standard/pull/814)) (@sealday)
- 修复 bug、自动完成、添加容错 ([#806](https://github.com/tegojs/tego-standard/pull/806)) (@bai.zixv)
- 支持附件 showCount 设置 ([#801](https://github.com/tegojs/tego-standard/pull/801)) (@bai.zixv)
- 结算表无关联费用支持其他类型 ([#799](https://github.com/tegojs/tego-standard/pull/799)) (@wjh)
- 结算表本期明细显示数量为0的内容 ([#796](https://github.com/tegojs/tego-standard/pull/796)) (@wjh)
- 修复视图, 当日期没有数据时,前端显示Invalid Date ([#767](https://github.com/tegojs/tego-standard/pull/767)) (@bai.zixv)
- 结算单显示具体规格逻辑修复 ([#770](https://github.com/tegojs/tego-standard/pull/770)) (@wjh)
- 改进发布流程 ([#773](https://github.com/tegojs/tego-standard/pull/773)) (@sealday)
- 结算单录单模块调整后没有显示录在明细中的无关联费用 close #764 ([#765](https://github.com/tegojs/tego-standard/pull/765)) (@wjh)
- createAt 字段错误 (@sealday)
- 导入es模块错误 (@sealday)
- 更新dockerfile (@sealday)
- 插件添加现在就可以了 (@sealday)
- 修复级联选择在编辑的时候没有默认值 close #633 ([#749](https://github.com/tegojs/tego-standard/pull/749)) (@wjh)
- 默认版本是0.0.1 (@sealday)
- 重命名图标搜索文件 ([#745](https://github.com/tegojs/tego-standard/pull/745)) (@bai.zixv)
- 优化筛选组件文本情况时加2s延迟，轮播图没有数据时添加提示 close #735 ([#738](https://github.com/tegojs/tego-standard/pull/738)) (@wjh)
- 修改结算单合并规则的订单数量不对 ([#734](https://github.com/tegojs/tego-standard/pull/734)) (@wjh)
- 修复自定义组件下拉框没有自定义显示选项 ([#730](https://github.com/tegojs/tego-standard/pull/730)) (@wjh)
- 修复mobile选择类型不能用的情况 fix #723 (@wjh)
- 多应用程序启动错误 (@sealday)
- 修复数据表自动编码没有提交按钮的bug, 去除布局组件 ([#722](https://github.com/tegojs/tego-standard/pull/722)) (@bai.zixv)
- 支持级联中的模糊搜索并修复未定义的标签 ([#718](https://github.com/tegojs/tego-standard/pull/718)) (@sealday)
- 合同结算单结束时间加一天减一毫秒，取当天的结束时间 ([#711](https://github.com/tegojs/tego-standard/pull/711)) (@hello@lv)
- 处理同名组件选择异常情况，文本切换组件阈值，时间选择具体范围 ([#712](https://github.com/tegojs/tego-standard/pull/712)) Co-authored-by: wjh <wwwjh0710@163.com> Co-committed-by: wjh <wwwjh0710@163.com> (@wjh)
- 建造 (@sealday)
- 忽略 core/cli/bin 错误 (@sealday)
- 导入json警告 (@sealday)
- 修改结算单导出Excel名称 ([#697](https://github.com/tegojs/tego-standard/pull/697)) fix #696 (@wjh)
- 修改筛选页面自定义筛选不能用 ([#698](https://github.com/tegojs/tego-standard/pull/698)) fix #699 (@wjh)
- 修复组件移动别的区块后出错 修复单选框点击出错 ([#680](https://github.com/tegojs/tego-standard/pull/680)) (@wjh)
- 调整mobile类型选择组件 ([#670](https://github.com/tegojs/tego-standard/pull/670)) Co-authored-by: wjh <wwwjh0710@163.com> Co-committed-by: wjh <wwwjh0710@163.com> (@wjh)
- 移动图标构建错误 (@sealday)
- 版本不匹配 (@sealday)
- 升级 (@sealday)
- 合同结算单打印预览单价计算、费用赔偿计算相关，出入库内容字段报错 (@wjh)
- 临时修复,模板第一次进入无法加载 ([#655](https://github.com/tegojs/tego-standard/pull/655)) (@bai.jingfeng)
- 修复分页问题 ([#631](https://github.com/tegojs/tego-standard/pull/631)) (@bai.jingfeng)
- 修改结算单产品计算逻辑 ([#630](https://github.com/tegojs/tego-standard/pull/630)) (@wjh)
- 源id和子表排序 (@sealday)
- 删除残留包 (@sealday)
- 基础分支集开发 (@sealday)
- 修改结算单产品计算逻辑 ([#619](https://github.com/tegojs/tego-standard/pull/619)) (@wjh)
- 上游跟进,(fix: sort params missing when switch page numbers #3906) (@bai.jingfeng)
- 上游跟进, source id为null的情况,fix-source id null #3917 (@bai.jingfeng)
- 复制修复 (@bai.jingfeng)
- 上游跟踪,fix- getSourceKeyByAssocation #3947 (@bai.jingfeng)
- 修改结算单计算逻辑 ([#612](https://github.com/tegojs/tego-standard/pull/612)) (@wjh)
- 修复更新antd后的导航图标样式异常 (@wjh)
- 配置字段,显示一对一的关联表的筛选项 (@bai.jingfeng)
- 修改汇总区块不格式化文本类型 (@wjh)
- 添加菜单 (@sealday)
- 导入错误 (@sealday)
- 应该阴影合并 (@sealday)
- 数据关联表引用自己的情况不显示内容-同步官方, 发布后需要重新配置区块 (@bai.jingfeng)
- 日期提交给后端设置为utc类型,单选类型有误差,后期需要系统整理日期格式问题 (@bai.jingfeng)
- 修复多标签页标题问题 (@sealday)
- 多应用程序启动错误 (@sealday)
- @formily/json-schema 导入 (@sealday)
- 消息通知点击已读，提示消息为清空 fix #467 (@lyx)
- 财务-明细查询,本公司,添加设置数据范围, 同步官方 ([#565](https://github.com/tegojs/tego-standard/pull/565)) (@bai.jingfeng)
- 正式加载错误 (@sealday)
- 正式版本 (@sealday)

### 🔄 变更

- 模块网络 ([#1908](https://github.com/tegojs/tego-standard/pull/1908)) (@sealday)
- 重命名包([#1907](https://github.com/tegojs/tego-standard/pull/1907)) (@sealday)
- 统一@formily/x ([#1906](https://github.com/tegojs/tego-standard/pull/1906)) (@sealday)
- 审批 UI 和系统设置翻译 ([#1905](https://github.com/tegojs/tego-standard/pull/1905)) (@sealday)
- 重命名某些包名称以更好地反映其实际意图 ([#1896](https://github.com/tegojs/tego-standard/pull/1896)) (@sealday)
- **data-source**: 数据源将表迁移到 table-v2 ([#1881](https://github.com/tegojs/tego-standard/pull/1881)) (@WinC159)
- 将移动客户端合并到客户端 ([#1886](https://github.com/tegojs/tego-standard/pull/1886)) (@sealday)
- 干净的代码 ([#1884](https://github.com/tegojs/tego-standard/pull/1884)) (@sealday)
- **hera**: 干净的代码 ([#1880](https://github.com/tegojs/tego-standard/pull/1880)) (@sealday)
- 删除未使用的通知模块 (@sealday)
- 删除原型 pdf 编辑器（合并到云组件中） (@sealday)
- **hera**: 干净的代码 ([#1865](https://github.com/tegojs/tego-standard/pull/1865)) (@sealday)
- 为节点添加自定义图标 ([#1855](https://github.com/tegojs/tego-standard/pull/1855)) (@bai.zixv)
- 重命名包([#1844](https://github.com/tegojs/tego-standard/pull/1844)) (@sealday)
- 工作流模块，分割默认节点视图 ([#1813](https://github.com/tegojs/tego-standard/pull/1813)) (@bai.zixv)
- **client**: 将 useCreateActionProps 和提交按钮操作从 hera 迁移到客户端 ([#1789](https://github.com/tegojs/tego-standard/pull/1789)) (@wjh)
- **workflow**: 工作流程执行移至表 v2 ([#1790](https://github.com/tegojs/tego-standard/pull/1790)) (@fanyukun)
- 批准([#1796](https://github.com/tegojs/tego-standard/pull/1796)) (@bai.zixv)
- 批准([#1794](https://github.com/tegojs/tego-standard/pull/1794)) (@bai.zixv)
- 删除兼容架构 ([#1784](https://github.com/tegojs/tego-standard/pull/1784)) (@sealday)
- **workflow**: 工作流程将表迁移到 TableV2 ([#1761](https://github.com/tegojs/tego-standard/pull/1761)) (@fanyukun)
- **approval**: 重命名包([#1779](https://github.com/tegojs/tego-standard/pull/1779)) (@sealday)
- 带有 antd 警报组件的通知区域 ([#1775](https://github.com/tegojs/tego-standard/pull/1775)) (@sealday)
- 批准([#1772](https://github.com/tegojs/tego-standard/pull/1772)) (@bai.zixv)
- 批准([#1769](https://github.com/tegojs/tego-standard/pull/1769)) (@bai.zixv)
- **approval**: 批准([#1749](https://github.com/tegojs/tego-standard/pull/1749)) (@bai.zixv)
- **client**: 分离出 requirejs ([#1754](https://github.com/tegojs/tego-standard/pull/1754)) (@sealday)
- **client**: tachybase 客户端自我引用 ([#1748](https://github.com/tegojs/tego-standard/pull/1748)) (@sealday)
- **approval**: 批准块启动架构 ([#1735](https://github.com/tegojs/tego-standard/pull/1735)) (@bai.zixv)
- 重命名为模块 ([#1729](https://github.com/tegojs/tego-standard/pull/1729)) (@sealday)
- 把js改成ts (@sealday)
- 更改批准文件名 ([#1720](https://github.com/tegojs/tego-standard/pull/1720)) (@bai.zixv)
- **approval**: 更改批准文件 ([#1719](https://github.com/tegojs/tego-standard/pull/1719)) (@bai.zixv)
- **lint**: 删除未使用的 lint deps ([#1718](https://github.com/tegojs/tego-standard/pull/1718)) (@sealday)
- mv 应用程序从包到应用程序 ([#1708](https://github.com/tegojs/tego-standard/pull/1708)) (@sealday)
- 人工智能助手和云组件 ([#1694](https://github.com/tegojs/tego-standard/pull/1694)) (@sealday)
- mv @hera 插件到 @tachybase 命名空间 ([#1683](https://github.com/tegojs/tego-standard/pull/1683)) (@sealday)
- 数据源([#1665](https://github.com/tegojs/tego-standard/pull/1665)) (@sealday)
- 重构下拉菜单，统一模态窗和抽屉的 UI，新增快捷入口区块 ([#1649](https://github.com/tegojs/tego-standard/pull/1649)) (@sealday)
- **di**: 准备下一个框架改进 ([#1634](https://github.com/tegojs/tego-standard/pull/1634)) (@sealday)
- **client**: 统一类名 ([#1594](https://github.com/tegojs/tego-standard/pull/1594)) (@sealday)
- **data-source-external**: 重命名包名称 ([#1578](https://github.com/tegojs/tego-standard/pull/1578)) (@sealday)
- 块初始化名称和设计图标 ([#1553](https://github.com/tegojs/tego-standard/pull/1553)) (@sealday)
- **department**: 开发([#1492](https://github.com/tegojs/tego-standard/pull/1492)) (@bai.zixv)
- **telemetry**: 如果禁用，则不初始化遥测 ([#1437](https://github.com/tegojs/tego-standard/pull/1437)) (@TomyJan)
- 删除演示 ([#1426](https://github.com/tegojs/tego-standard/pull/1426)) (@sealday)
- 常规清除 api ([#1415](https://github.com/tegojs/tego-standard/pull/1415)) (@sealday)
- webhooks 重命名为调度程序 ([#1385](https://github.com/tegojs/tego-standard/pull/1385)) (@sealday)
- 批准、行动 ([#1346](https://github.com/tegojs/tego-standard/pull/1346)) (@bai.zixv)
- 批准，重命名([#1319](https://github.com/tegojs/tego-standard/pull/1319)) (@bai.zixv)
- 删除通知和批准 ([#1276](https://github.com/tegojs/tego-standard/pull/1276)) (@sealday)
- 准备 SAAS ([#1239](https://github.com/tegojs/tego-standard/pull/1239)) (@sealday)
- 工作流程#1229 (@sealday)
- Webhook 名称 ([#1220](https://github.com/tegojs/tego-standard/pull/1220)) (@sealday)
- 优化绑定工作流程，将代码镜像移动到组件并将lib添加到webhook ([#1219](https://github.com/tegojs/tego-standard/pull/1219)) (@sealday)
- 工作流程/webhook/部门 ([#1207](https://github.com/tegojs/tego-standard/pull/1207)) (@sealday)
- 部门批准([#1206](https://github.com/tegojs/tego-standard/pull/1206)) (@sealday)
- 部门([#1205](https://github.com/tegojs/tego-standard/pull/1205)) (@sealday)
- 块项目表单项目卡项目变量([#1165](https://github.com/tegojs/tego-standard/pull/1165)) (@sealday)
- 核心库 ([#1158](https://github.com/tegojs/tego-standard/pull/1158)) (@sealday)
- 从 Hera-core 到 @tachybase/plugin-workflow ([#1156](https://github.com/tegojs/tego-standard/pull/1156)) (@sealday)
- 处理风格改进 ([#1140](https://github.com/tegojs/tego-standard/pull/1140)) (@sealday)
- 客户端 ([#1092](https://github.com/tegojs/tego-standard/pull/1092)) (@sealday)
- @hera/插件核心 ([#1081](https://github.com/tegojs/tego-standard/pull/1081)) (@sealday)
- 客户端内置插件 ([#1067](https://github.com/tegojs/tego-standard/pull/1067)) (@sealday)
- 类型正确 ([#1056](https://github.com/tegojs/tego-standard/pull/1056)) (@sealday)
- @hera/plugin-core，部门插件([#979](https://github.com/tegojs/tego-standard/pull/979)) (@bai.zixv)
- 迁移名称 ([#1050](https://github.com/tegojs/tego-standard/pull/1050)) (@sealday)
- @emotion/css 到 antd 风格 ([#1044](https://github.com/tegojs/tego-standard/pull/1044)) (@sealday)
- 将 @emotion/css 迁移到 antd 风格 ([#1043](https://github.com/tegojs/tego-standard/pull/1043)) (@sealday)
- 将@emotion/css替换为@tachybase/client，支持导入排序([#1039](https://github.com/tegojs/tego-standard/pull/1039)) (@sealday)
- 多应用程序和插件 ([#1021](https://github.com/tegojs/tego-standard/pull/1021)) (@sealday)
- 个人主页插件 ([#1003](https://github.com/tegojs/tego-standard/pull/1003)) (@sealday)
- @hera/plugin-core @tachybase/schema，删除未使用的插件图表 ([#887](https://github.com/tegojs/tego-standard/pull/887)) (@sealday)
- 优化上下文菜单并清理@hera/plugin-core ([#886](https://github.com/tegojs/tego-standard/pull/886)) (@sealday)
- 迁移助手/页面样式/hera-version ([#817](https://github.com/tegojs/tego-standard/pull/817)) (@sealday)
- excel 部分重构，优化弹窗体验 ([#598](https://github.com/tegojs/tego-standard/pull/598)) (@bai.jingfeng)
- 将内部方法迁移到 @nocobase/schema (@sealday)
- 跟踪上游,(refactor: change useProps to x-use-component-props ([#3853](https://github.com/tegojs/tego-standard/pull/3853))) ([#629](https://github.com/tegojs/tego-standard/pull/629)) (@bai.jingfeng)
- 删除未使用的公式插件 (@sealday)
- **approval**: 迁移审批插件 ([#1773](https://github.com/tegojs/tego-standard/pull/1773)) (@bai.zixv)
- 改进 lint ([#1717](https://github.com/tegojs/tego-standard/pull/1717)) (@sealday)
- 工作流 HTTP给个写备注的地方. 以防后续不知道节点数据含义 ([#1672](https://github.com/tegojs/tego-standard/pull/1672)) (@Toby)
- **plugin-wechat-auth**: 添加到 tachybase 预设 ([#1520](https://github.com/tegojs/tego-standard/pull/1520)) (@TomyJan)
- **plugin-logger**: 权限控制和日志预览 ([#1491](https://github.com/tegojs/tego-standard/pull/1491)) (@TomyJan)
- **telemetry**: 使用自托管仪器库 ([#1446](https://github.com/tegojs/tego-standard/pull/1446)) (@TomyJan)
- **telemetry**: 尽快加载遥测数据 ([#1431](https://github.com/tegojs/tego-standard/pull/1431)) (@TomyJan)
- **build**: 请不要输出红色日志 ([#1406](https://github.com/tegojs/tego-standard/pull/1406)) (@TomyJan)
- 用户删除权限判断([#1363](https://github.com/tegojs/tego-standard/pull/1363)) (@TomyJan)
- 表单项 ([#1171](https://github.com/tegojs/tego-standard/pull/1171)) (@sealday)
- 优化 pdf 加载 ([#827](https://github.com/tegojs/tego-standard/pull/827)) (@sealday)

### 📝 文档

- 更新自述文件 (@sealday)
- 更新自述文件.md (@sealday)
- 更新自述文件 (@sealday)
- 修复PNG (@sealday)
- 添加一些案例 (@sealday)
- 更新自述文件 (@sealday)
- 更新自述文件 (@sealday)
- 更新自述文件 (@sealday)
- 更新自述文件 (@sealday)
- 更新README.md (@sealday)
- 自述文件.md (@sealday)
- 更新自述文件.md (@sealday)
- 更新 readme.md ([#1807](https://github.com/tegojs/tego-standard/pull/1807)) (@sealday)
- 更新自述文件.md (@sealday)
- 更新自述文件 ([#1756](https://github.com/tegojs/tego-standard/pull/1756)) (@sealday)
- 更新许可证 (@sealday)
- 更新自述文件.md (@sealday)
- 更新 readme.md ([#1751](https://github.com/tegojs/tego-standard/pull/1751)) (@sealday)
- 更新自述文件 ([#1663](https://github.com/tegojs/tego-standard/pull/1663)) (@sealday)
- 更新自述文件 ([#1656](https://github.com/tegojs/tego-standard/pull/1656)) (@sealday)
- 更新 README.EN-US.md ([#1640](https://github.com/tegojs/tego-standard/pull/1640)) (@sealday)
- 更新 README.md ([#1639](https://github.com/tegojs/tego-standard/pull/1639)) (@sealday)
- 更新自述文件 ([#1618](https://github.com/tegojs/tego-standard/pull/1618)) (@sealday)
- 自述文件([#1601](https://github.com/tegojs/tego-standard/pull/1601)) (@sealday)
- 新自述文件 ([#1596](https://github.com/tegojs/tego-standard/pull/1596)) (@sealday)
- 更新自述文件 ([#1595](https://github.com/tegojs/tego-standard/pull/1595)) (@sealday)


[未发布]: https://github.com/tegojs/tego-standard/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.6.0
[1.5.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.5.1
[1.5.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.5.0
[1.4.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.4.0
[1.3.27]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.27
[1.3.26]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.26
[1.3.25]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.25
[1.3.24]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.24
[1.3.23]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.23
[1.3.22]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.22
[1.3.21]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.21
[1.3.20]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.20
[1.3.19]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.19
[1.3.18]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.18
[1.3.17]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.17
[1.3.16]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.16
[1.3.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.15
[1.3.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.14
[1.3.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.13
[1.3.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.12
[1.3.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.11
[1.3.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.10
[1.3.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.8
[1.3.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.7
[1.3.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.6
[1.3.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.5
[1.3.4]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.4
[1.3.2]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.2
[1.3.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.1
[1.3.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.3.0
[1.2.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.15
[1.2.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.14
[1.2.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.13
[1.2.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.12
[1.2.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.11
[1.2.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.10
[1.2.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.8
[1.2.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.7
[1.2.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.6
[1.2.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.5
[1.2.3]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.3
[1.2.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.2.0
[1.1.33]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.33
[1.1.30]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.30
[1.1.29]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.29
[1.1.24]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.24
[1.1.23]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.23
[1.1.22]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.22
[1.1.21]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.21
[1.1.20]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.20
[1.1.17]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.17
[1.1.16]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.16
[1.1.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.15
[1.1.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.14
[1.1.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.13
[1.1.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.12
[1.1.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.11
[1.1.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.10
[1.1.9]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.9
[1.1.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.8
[1.1.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.7
[1.1.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.6
[1.1.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.5
[1.1.4]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.4
[1.1.3]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.3
[1.1.2]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.2
[1.1.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.1
[1.1.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.1.0
[1.0.25]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.25
[1.0.23]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.23
[1.0.22]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.22
[1.0.20]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.20
[1.0.19]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.19
[1.0.18]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.18
[1.0.17]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.17
[1.0.16]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.16
[1.0.15]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.15
[1.0.14]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.14
[1.0.13]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.13
[1.0.12]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.12
[1.0.11]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.11
[1.0.10]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.10
[1.0.9]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.9
[1.0.8]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.8
[1.0.7]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.7
[1.0.6]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.6
[1.0.5]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.5
[1.0.4]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.4
[1.0.3]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.3
[1.0.2]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.2
[1.0.1]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.1
[1.0.0]: https://github.com/tegojs/tego-standard/releases/tag/v1.0.0
[0.23.66]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.66
[0.23.65]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.65
[0.23.64]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.64
[0.23.63]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.63
[0.23.62]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.62
[0.23.61]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.61
[0.23.60]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.60
[0.23.59]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.59
[0.23.58]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.58
[0.23.57]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.57
[0.23.56]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.56
[0.23.55]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.55
[0.23.54]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.54
[0.23.53]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.53
[0.23.52]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.52
[0.23.51]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.51
[0.23.50]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.50
[0.23.49]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.49
[0.23.48]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.48
[0.23.47]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.47
[0.23.46]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.46
[0.23.45]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.45
[0.23.44]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.44
[0.23.43]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.43
[0.23.42]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.42
[0.23.41]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.41
[0.23.40]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.40
[0.23.39]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.39
[0.23.38]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.38
[0.23.37]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.37
[0.23.36]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.36
[0.23.35]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.35
[0.23.34]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.34
[0.23.33]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.33
[0.23.32]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.32
[0.23.30]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.30
[0.23.29]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.29
[0.23.28]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.28
[0.23.27]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.27
[0.23.26]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.26
[0.23.25]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.25
[0.23.23]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.23
[0.23.22]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.22
[0.23.21]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.21
[0.23.20]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.20
[0.23.18]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.18
[0.23.17]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.17
[0.23.16]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.16
[0.23.15]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.15
[0.23.11]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.11
[0.23.10]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.10
[0.23.9]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.9
[0.23.8]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.8
[0.23.7]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.7
[0.23.5]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.5
[0.23.4]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.4
[0.23.3]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.3
[0.23.2]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.2
[0.23.1]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.1
[0.23.0]: https://github.com/tegojs/tego-standard/releases/tag/v0.23.0
[0.22.85]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.85
[0.22.84]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.84
[0.22.83]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.83
[0.22.82]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.82
[0.22.81]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.81
[0.22.75]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.75
[0.22.72]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.72
[0.22.69]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.69
[0.22.62]: https://github.com/tegojs/tego-standard/releases/tag/v0.22.62
[0.0.3]: https://github.com/tegojs/tego-standard/releases/tag/v0.0.3