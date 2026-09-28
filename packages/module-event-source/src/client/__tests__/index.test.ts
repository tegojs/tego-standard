import ModuleEventSourceClient from '..';

describe('event source client', () => {
  it('registers the HTTP endpoint type used by existing code webhooks', async () => {
    const plugin = new ModuleEventSourceClient({}, {
      systemSettingsManager: {
        add: vi.fn(),
      },
    } as any);

    await plugin.load();

    expect(plugin.triggers.get('code')).toMatchObject({
      title: expect.anything(),
      options: {},
    });
  });
});
