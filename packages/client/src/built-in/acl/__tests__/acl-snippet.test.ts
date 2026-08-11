import { getAclSnippetChecked, updateAclSnippetSelection } from '../acl-snippet';

describe('acl snippet helpers', () => {
  it('should read explicit snippets directly and inherited snippets through negated values', () => {
    expect(getAclSnippetChecked({ aclMode: 'explicit', aclSnippet: 'pm.a' }, ['pm.a'])).toBe(true);
    expect(getAclSnippetChecked({ aclSnippet: 'pm.b' }, ['!pm.b'])).toBe(false);
  });

  it('should update explicit and inherited snippet selections with the same mutation rules', async () => {
    const resource = {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };

    await updateAclSnippetSelection(resource, true, { aclMode: 'explicit', aclSnippet: 'pm.explicit' });
    expect(resource.remove).toHaveBeenCalledWith({ values: ['pm.explicit'] });

    await updateAclSnippetSelection(resource, false, {
      aclSnippet: 'pm.parent',
      children: [{ aclSnippet: 'pm.child' }],
    });
    expect(resource.remove).toHaveBeenCalledWith({ values: ['!pm.child', '!pm.parent'] });
  });
});
