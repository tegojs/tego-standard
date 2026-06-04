export async function bindMenuToRole({ schemaInstance, db, options }) {
  const { transaction, position, target } = options;
  const addNewMenuRoles = await db.getRepository('roles').find({
    filter: {
      allowNewMenu: true,
    },
  });

  const uid = schemaInstance.get('x-uid');

  let ancestorSet = new Set();
  ancestorSet.add(uid);
  if (target) {
    const ancestorList = await db.getRepository('uiSchemaTreePath').find({
      fields: ['ancestor'],
      filter: {
        descendant: target,
      },
      transaction,
    });
    ancestorList.forEach((ancestor) => {
      ancestorSet.add(ancestor.get('ancestor'));
    });
    // 插入兄弟节点时候 获取祖先节点则需要去掉这个节点
    // 对于子节点插入(afterBegin/beforeEnd)，target是父节点，也需要从祖先集合中移除
    // 因为 ancestorList 的查询结果包含了 target 自身的深度0引用
    ancestorSet.delete(target);
  }

  for (const role of addNewMenuRoles) {
    await db.getRepository('roles.menuUiSchemas', role.get('name')).add({
      tk: [...ancestorSet],
      transaction,
    });
  }
}
