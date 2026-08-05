import { describe, expect, it, vi } from 'vitest';

import { deferUntilTransactionCommitSucceeds } from '../deferAfterCommit';

function createTransaction(parent?: any) {
  return {
    parent,
    commit: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
  };
}

describe('deferUntilTransactionCommitSucceeds', () => {
  it('moves callbacks through three committed transaction levels in registration order', async () => {
    const root = createTransaction();
    const child = createTransaction(root);
    const grandchild = createTransaction(child);
    const calls: string[] = [];

    deferUntilTransactionCommitSucceeds(root, [() => calls.push('root')]);
    deferUntilTransactionCommitSucceeds(child, [() => calls.push('child')]);
    deferUntilTransactionCommitSucceeds(grandchild, [() => calls.push('grandchild')]);

    await grandchild.commit();
    await child.commit();
    expect(calls).toEqual([]);

    await root.commit();
    expect(calls).toEqual(['root', 'child', 'grandchild']);
  });

  it('keeps committed sibling callbacks and discards rolled-back sibling callbacks', async () => {
    const root = createTransaction();
    const committedChild = createTransaction(root);
    const rolledBackChild = createTransaction(root);
    const calls: string[] = [];

    deferUntilTransactionCommitSucceeds(committedChild, [() => calls.push('committed')]);
    deferUntilTransactionCommitSucceeds(rolledBackChild, [() => calls.push('rolled-back')]);

    await committedChild.commit();
    await rolledBackChild.rollback();
    await root.commit();

    expect(calls).toEqual(['committed']);
  });

  it('discards migrated callbacks when the root transaction rolls back', async () => {
    const root = createTransaction();
    const child = createTransaction(root);
    const callback = vi.fn();

    deferUntilTransactionCommitSucceeds(child, [callback]);
    await child.commit();
    await root.rollback();

    expect(callback).not.toHaveBeenCalled();
  });

  it('does not run callbacks when the transaction commit fails', async () => {
    const transaction = createTransaction();
    const callback = vi.fn();
    transaction.commit.mockRejectedValueOnce(new Error('commit failed'));

    deferUntilTransactionCommitSucceeds(transaction, [callback]);

    await expect(transaction.commit()).rejects.toThrow('commit failed');
    expect(callback).not.toHaveBeenCalled();
  });

  it('runs every callback and aggregates callback failures after a successful commit', async () => {
    const transaction = createTransaction();
    const first = vi.fn(async () => {
      throw new Error('first callback failed');
    });
    const second = vi.fn(async () => undefined);
    const third = vi.fn(async () => {
      throw new Error('third callback failed');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      deferUntilTransactionCommitSucceeds(transaction, [first, second, third]);

      await expect(transaction.commit()).resolves.toBeUndefined();

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Deferred after-commit callbacks failed',
        expect.any(AggregateError),
      );
      expect(first).toHaveBeenCalledOnce();
      expect(second).toHaveBeenCalledOnce();
      expect(third).toHaveBeenCalledOnce();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('keeps each nested registration bound to its own error reporter', async () => {
    const root = createTransaction();
    const child = createTransaction(root);
    const rootReporter = vi.fn();
    const childReporter = vi.fn();

    deferUntilTransactionCommitSucceeds(
      root,
      [
        async () => {
          throw new Error('root callback failed');
        },
      ],
      rootReporter,
    );
    deferUntilTransactionCommitSucceeds(
      child,
      [
        async () => {
          throw new Error('child callback failed');
        },
      ],
      childReporter,
    );

    await child.commit();
    await root.commit();

    expect(rootReporter).toHaveBeenCalledWith(expect.objectContaining({ message: 'root callback failed' }));
    expect(childReporter).toHaveBeenCalledWith(expect.objectContaining({ message: 'child callback failed' }));
  });

  it('keeps the database commit successful when callback failures are reported separately', async () => {
    const transaction = createTransaction();
    const callback = vi.fn(async () => {
      throw new Error('post-commit failed');
    });
    const reportError = vi.fn().mockRejectedValue(new Error('report failed'));
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      deferUntilTransactionCommitSucceeds(transaction, [callback], reportError);

      await expect(transaction.commit()).resolves.toBeUndefined();
      expect(callback).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledOnce();
      expect(reportError).toHaveBeenCalledWith(expect.any(Error));
      expect(consoleErrorSpy).toHaveBeenCalledWith('Deferred after-commit error reporting failed', expect.any(Error));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not reject a commit when callback failures have no reporter', async () => {
    const transaction = createTransaction();
    const callback = vi.fn(async () => {
      throw new Error('unreported post-commit failed');
    });
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      deferUntilTransactionCommitSucceeds(transaction, [callback]);

      await expect(transaction.commit()).resolves.toBeUndefined();
      expect(consoleErrorSpy).toHaveBeenCalledWith('Deferred after-commit callbacks failed', expect.any(Error));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
