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

    deferUntilTransactionCommitSucceeds(transaction, [first, second, third]);

    let caughtError: any;
    try {
      await transaction.commit();
    } catch (error) {
      caughtError = error;
    }

    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    expect(caughtError).toBeInstanceOf(AggregateError);
    expect(caughtError.errors.map((error) => error.message)).toEqual([
      'first callback failed',
      'third callback failed',
    ]);
  });
});
