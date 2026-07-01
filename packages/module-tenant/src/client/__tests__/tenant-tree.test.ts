import { buildTenantTree, getTenantParentOptions } from '../tenant-tree';

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
});
