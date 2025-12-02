/**
 * 数据清洗工具函数：清除关联字段的 id
 * 用于复制操作时，避免关联字段的 id 被认为是已有数据，从而被误认为是修改而不是新建
 *
 * @param data - 要清洗的数据对象
 * @param collection - collection 对象（可选），用于获取字段信息以更精确地处理
 * @returns 清洗后的数据对象
 */
export function cleanAssociationIds(data: any, collection?: any): any {
  if (!data || typeof data !== 'object') {
    return data;
  }

  // 创建数据副本，避免修改原数据
  const cleanedData = Array.isArray(data) ? [...data] : { ...data };

  // 获取 collection 的字段信息（如果可用）
  const fields = collection?.fields || [];

  // 构建关联字段映射，用于识别多对多和一对多关联
  const associationArrayFields = new Set<string>();

  fields.forEach((field: any) => {
    if ((field.type === 'belongsToMany' || field.type === 'hasMany') && field.name) {
      associationArrayFields.add(field.name);
    }
  });

  // 处理外键字段（belongsTo）
  // 清除所有形如 xxxId 的字段（外键字段），但保留 id, createdById, updatedById
  Object.keys(cleanedData).forEach((key) => {
    if (key.endsWith('Id') && key !== 'id' && key !== 'createdById' && key !== 'updatedById') {
      // 如果值不为 null/undefined，说明是外键字段，需要清除
      if (cleanedData[key] != null) {
        delete cleanedData[key];
      }
    }
  });

  // 处理关联数组字段（belongsToMany, hasMany）
  // 如果字段在 associationArrayFields 中，或者是数组且包含对象，则清除数组中每个对象的 id
  Object.keys(cleanedData).forEach((key) => {
    const value = cleanedData[key];
    if (Array.isArray(value) && value.length > 0) {
      // 检查是否是对象数组（关联数组）
      const isObjectArray = value.some((item) => item && typeof item === 'object' && 'id' in item);
      if (isObjectArray || associationArrayFields.has(key)) {
        cleanedData[key] = value.map((item: any) => {
          if (item && typeof item === 'object') {
            // 清除数组中每个对象的 id
            const cleanedItem = { ...item };
            delete cleanedItem.id;
            // 递归处理嵌套的关联字段
            return cleanAssociationIds(cleanedItem, collection);
          }
          return item;
        });
      }
    }
  });

  return cleanedData;
}
