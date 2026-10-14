import { Plugin, useCollection, useRequest } from '@tachybase/client';

import { ProviderApprovalUpdateForm } from '../../../common/contexts/ApprovalUpdateForm.provider';
import { tval } from '../../../locale';
import { KitApprovalCommon } from '../common/kit';
import { InitiateApplication } from './apply-list-old/InitiateApplication';
import { ApplyList } from './apply-list/ApplyList';
import { CreateCheckCancelAction, CreateCheckLink, createCheckSubmitAction } from './component/CreateCheckLink';
import { KitApprovalBlockInitializer } from './initializers/kit';
import { CarbonCopyBlockProvider } from './table-carbon-copy/CarbonCopyBlock.provider';
import { CarbonCopyCenter } from './table-carbon-copy/CarbonCopyCenter.schema';
import { ViewCheckLink as ViewCheckLinkInitiations } from './table-initiations/CheckLink.view';
import { ViewTableInitiated } from './table-initiations/TableInitiated';
import { ViewCheckLink as ViewCheckLinkTodos } from './table-todos/CheckLink.view';
import { ViewTableTodos } from './table-todos/TableTodos.view';

const QuickApprovalSchema = {
  title: tval('Quickly initiate approval'),
  Component: CreateCheckLink,
  name: 'workflowApproval',
  useVisible() {
    const collection = useCollection();
    const { data } = useRequest({
      url: 'workflows:list',
      params: {
        filter: {
          'config.centralized': true,
          enabled: true,
          'config.collection': collection.name,
        },
      },
    });
    return (
      (collection.template !== 'view' || collection?.writableView) &&
      collection.template !== 'file' &&
      collection.template !== 'sql' &&
      data?.data?.length
    );
  },
};
export class KitApprovalBlock extends Plugin {
  async afterAdd() {
    this.pm.add(KitApprovalCommon);
    this.pm.add(KitApprovalBlockInitializer);
  }

  async load() {
    this.app.addComponents({
      CarbonCopyBlockProvider: CarbonCopyBlockProvider,
      CarbonCopyCenter: CarbonCopyCenter,
      CreateCheckCancelAction: CreateCheckCancelAction,
      createCheckSubmitAction: createCheckSubmitAction,
      // NOTE: 这里注册在全局, 而不是组件内的作用域, 是为了让手机端共享到
      ProviderApprovalUpdateForm: ProviderApprovalUpdateForm,

      /**
       * DOC:
       * 新的用法, 注册在全局, 而不是组件内的作用域的时候, 使用可以区分的前缀标明作用域
       * 同时组件名和原名称保持一致,为了能够快速搜索定位 schema 里的原组件
       * 例如:'Approval-ProviderBlockInitItem'
       * 冒号语法有些问题, 读取的方法里应该有特殊解析逻辑, 暂时用 - 连接
       */

      'Approval-InitiateApplication': InitiateApplication,
      'Approval-ViewTableInitiated': ViewTableInitiated,
      'Approval-ViewTableTodos': ViewTableTodos,
      'Approval-FeatureList': ApplyList,
      /**
       * @deprecated
       * 兼容旧版用法, 防止线上已经按照旧版配置的 schema, 运行的时候找不到原组件
       */
      'ApprovalBlock.Launch': ViewTableInitiated,
      'ApprovalBlock.Launch.Application': InitiateApplication,
      'ApprovalBlock.Todos': ViewTableTodos,
      'ApprovalBlock.ViewActionLaunch': ViewCheckLinkInitiations,
      'ApprovalBlock.ViewActionTodos': ViewCheckLinkTodos,
    });
    this.app.schemaInitializerManager.addItem(
      `details:configureActions`,
      'customize.workflowApproval',
      QuickApprovalSchema,
    );
    this.app.schemaInitializerManager.addItem(
      `editForm:configureActions`,
      'customize.workflowApproval',
      QuickApprovalSchema,
    );
  }
}
