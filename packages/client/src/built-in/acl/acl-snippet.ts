type AclSnippetRecord = {
  aclMode?: string;
  aclSnippet?: string;
  children?: AclSnippetRecord[];
};

type AclSnippetResource = {
  add?: (options: { values: string[] }) => Promise<any>;
  remove?: (options: { values: string[] }) => Promise<any>;
};

export const isExplicitAclSnippet = (record?: AclSnippetRecord) => record?.aclMode === 'explicit';

const isString = (value?: string): value is string => typeof value === 'string';

function assertAclSnippetResource(resource: AclSnippetResource): asserts resource is Required<AclSnippetResource> {
  if (typeof resource.add !== 'function' || typeof resource.remove !== 'function') {
    throw new Error('roles.snippets resource does not support acl snippet mutations');
  }
}

export const getChildrenAclSnippetKeys = (data: AclSnippetRecord[] = [], arr: string[] = []) => {
  for (const item of data) {
    if (item.aclSnippet) {
      arr.push(item.aclSnippet);
    }
    if (item.children?.length) {
      getChildrenAclSnippetKeys(item.children, arr);
    }
  }
  return arr;
};

export const getAclSnippetChecked = (record: AclSnippetRecord, snippets: string[]) => {
  return isExplicitAclSnippet(record)
    ? snippets.includes(record.aclSnippet)
    : !snippets.includes(`!${record.aclSnippet}`);
};

export async function updateAclSnippetSelection(
  resource: AclSnippetResource,
  checked: boolean,
  record: AclSnippetRecord,
) {
  assertAclSnippetResource(resource);

  if (isExplicitAclSnippet(record)) {
    const values = [record.aclSnippet].filter(isString);
    if (checked) {
      await resource.remove({ values });
    } else {
      await resource.add({ values });
    }
    return;
  }

  const childrenKeys = getChildrenAclSnippetKeys(record?.children, []);
  const totalKeys = childrenKeys.concat(record.aclSnippet).filter(isString);
  const values = totalKeys.map((value) => `!${value}`);
  if (!checked) {
    await resource.remove({ values });
  } else {
    await resource.add({ values });
  }
}
