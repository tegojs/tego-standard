import { Op, type WhereOptions } from '@tego/server';

import type { AccessFilterNode } from './filter-tree';

/** Translate an already validated root-only tree without treating request strings as ACL variables. */
export function rootFilterWhere(node: AccessFilterNode, primaryKey: string): WhereOptions | undefined {
  const predicate = rootPredicate(node);
  return typeof predicate === 'boolean' ? (predicate ? {} : { [primaryKey]: { [Op.in]: [] } }) : predicate;
}

function rootPredicate(node: AccessFilterNode): WhereOptions | boolean | undefined {
  switch (node.type) {
    case 'predicate':
      return node.where;
    case 'all':
    case 'any': {
      const conjunction = node.type === 'all';
      const children = node.children.map(rootPredicate);
      if (children.some((child) => child === undefined)) return;
      if (children.includes(!conjunction)) return !conjunction;
      const clauses = children.filter((child): child is WhereOptions => typeof child !== 'boolean');
      return clauses.length ? { [conjunction ? Op.and : Op.or]: clauses } : conjunction;
    }
    case 'not': {
      const child = rootPredicate(node.child);
      return child === undefined ? undefined : typeof child === 'boolean' ? !child : { [Op.not]: child };
    }
    default:
      return;
  }
}
