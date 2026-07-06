import { buildTenantTree, getTenantParentOptions, loadTenantRecords } from '../tenant-tree';

describe('tenant tree helpers', () => {
  it('should build nested tenant tree from flat tenant records', () => {
    const tree = buildTenantTree([
      { id: 'root', name: 'root', path: '/root/' },
      { id: 'child', name: 'child', parentId: 'root', path: '/root/child/' },
      { id: 'sibling', name: 'sibling', path: '/sibling/' },
      { id: 'grandchild', name: 'grandchild', parentId: 'child', path: '/root/child/grandchild/' },
    ]);

    expect(tree).toEqual([
      {
        id: 'root',
        name: 'root',
        path: '/root/',
        children: [
          {
            id: 'child',
            name: 'child',
            parentId: 'root',
            path: '/root/child/',
            children: [
              {
                id: 'grandchild',
                name: 'grandchild',
                parentId: 'child',
                path: '/root/child/grandchild/',
              },
            ],
          },
        ],
      },
      {
        id: 'sibling',
        name: 'sibling',
        path: '/sibling/',
      },
    ]);
  });

  it('should exclude the edited tenant and descendants from parent options', () => {
    const options = getTenantParentOptions(
      [
        { id: 'root', name: 'root', title: 'Root', path: '/root/' },
        { id: 'child', name: 'child', title: 'Child', parentId: 'root', path: '/root/child/' },
        { id: 'grandchild', name: 'grandchild', parentId: 'child', path: '/root/child/grandchild/' },
        { id: 'other', name: 'other', path: '/other/' },
      ],
      { id: 'child', name: 'child', parentId: 'root', path: '/root/child/' },
    );

    expect(options).toEqual([
      { label: 'Root', value: 'root' },
      { label: 'other', value: 'other' },
    ]);
  });

  it('should not treat sibling tenant paths with a common prefix as descendants', () => {
    const options = getTenantParentOptions(
      [
        { id: 'root', name: 'root', path: '/root/' },
        { id: 'child', name: 'child', path: '/root/child/' },
        { id: 'child-2', name: 'child-2', path: '/root/child-2/' },
      ],
      { id: 'child', name: 'child', path: '/root/child/' },
    );

    expect(options).toEqual([
      { label: 'root', value: 'root' },
      { label: 'child-2', value: 'child-2' },
    ]);
  });

  it('should exclude descendants by parent hierarchy when paths are missing', () => {
    const options = getTenantParentOptions(
      [
        { id: 'root', name: 'root' },
        { id: 'child', name: 'child', parentId: 'root' },
        { id: 'grandchild', name: 'grandchild', parentId: 'child' },
        { id: 'other', name: 'other' },
      ],
      { id: 'child', name: 'child', parentId: 'root' },
    );

    expect(options).toEqual([
      { label: 'root', value: 'root' },
      { label: 'other', value: 'other' },
    ]);
  });

  it('should handle dirty parentId self-references without returning the edited tenant', () => {
    const options = getTenantParentOptions(
      [
        { id: 'root', name: 'root' },
        { id: 'dirty', name: 'dirty', parentId: 'dirty' },
        { id: 'other', name: 'other' },
      ],
      { id: 'dirty', name: 'dirty', parentId: 'dirty' },
    );

    expect(options).toEqual([
      { label: 'root', value: 'root' },
      { label: 'other', value: 'other' },
    ]);
  });

  it('should expose tenants in a cycle as roots instead of dropping them', () => {
    const tree = buildTenantTree([
      { id: 'a', name: 'a', parentId: 'c' },
      { id: 'b', name: 'b', parentId: 'a' },
      { id: 'c', name: 'c', parentId: 'b' },
      { id: 'outside', name: 'outside' },
    ]);

    expect(tree.map((tenant) => tenant.id).sort()).toEqual(['a', 'b', 'c', 'outside']);
  });

  it('should handle parentId cycles while excluding discovered descendants', () => {
    const options = getTenantParentOptions(
      [
        { id: 'a', name: 'a', parentId: 'c' },
        { id: 'b', name: 'b', parentId: 'a' },
        { id: 'c', name: 'c', parentId: 'b' },
        { id: 'outside', name: 'outside' },
      ],
      { id: 'a', name: 'a', parentId: 'c' },
    );

    expect(options).toEqual([{ label: 'outside', value: 'outside' }]);
  });

  it('should stop loading tenant records after the safety page limit', async () => {
    const list = vi.fn(({ page, pageSize }) =>
      Promise.resolve({
        data: {
          data: Array.from({ length: pageSize }, (_, index) => ({
            id: `tenant-${page}-${index}`,
            name: `tenant-${page}-${index}`,
          })),
        },
      }),
    );
    const api = {
      resource: () => ({ list }),
    };

    const records = await loadTenantRecords(api, () => false, 2);

    expect(list).toHaveBeenCalledTimes(1000);
    expect(records).toHaveLength(2000);
  });
});
