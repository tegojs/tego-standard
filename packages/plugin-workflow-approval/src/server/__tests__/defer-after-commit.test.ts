import { describe, expect, it, vi } from 'vitest';

import { deferUntilTransactionCommitSucceeds, runDeferredAfterCommitCallbacks } from '../defer-after-commit';

const CALLBACK_FAILURE = 'Deferred after-commit callbacks failed';
const DEFERRED_REPORTING_FAILURE = 'Deferred after-commit error reporting failed';

function createTransaction(parent?: any) {
  const transaction = {
    parent,
    finished: undefined,
    commit: vi.fn(async () => {
      transaction.finished = 'commit';
    }),
    rollback: vi.fn(async () => {
      transaction.finished = 'rollback';
    }),
  };
  return transaction;
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

  it('uses one rollback wrapper and reports every pending registration once', async () => {
    const transaction = createTransaction();
    const firstRollback = vi.fn();
    const secondRollback = vi.fn();

    deferUntilTransactionCommitSucceeds(transaction, [vi.fn()], undefined, firstRollback);
    const wrappedRollback = transaction.rollback;
    deferUntilTransactionCommitSucceeds(transaction, [vi.fn()], undefined, secondRollback);

    expect(transaction.rollback).toBe(wrappedRollback);
    await transaction.rollback();
    await transaction.rollback();
    expect(firstRollback).toHaveBeenCalledOnce();
    expect(secondRollback).toHaveBeenCalledOnce();
  });

  it('does not run rollback callbacks after the transaction has committed', async () => {
    const transaction = createTransaction();
    const rollbackCallback = vi.fn();

    await transaction.commit();
    deferUntilTransactionCommitSucceeds(transaction, [vi.fn()], undefined, rollbackCallback);
    await transaction.rollback();

    expect(rollbackCallback).not.toHaveBeenCalled();
  });

  it('retains callbacks when transaction validation fails', () => {
    const callback = vi.fn();
    const callbacks = [callback];

    expect(() => deferUntilTransactionCommitSucceeds({}, callbacks)).toThrow(
      'External approval transaction must expose a commit method',
    );
    expect(callbacks).toEqual([callback]);
  });

  it('retains callbacks and allows retry when transaction wrapping fails', async () => {
    const transaction = createTransaction();
    const callback = vi.fn();
    const callbacks = [callback];
    const commit = transaction.commit;
    Object.defineProperty(transaction, 'commit', {
      configurable: true,
      value: commit,
      writable: false,
    });

    expect(() => deferUntilTransactionCommitSucceeds(transaction, callbacks)).toThrow(TypeError);
    expect(callbacks).toEqual([callback]);

    Object.defineProperty(transaction, 'commit', {
      configurable: true,
      value: commit,
      writable: true,
    });
    deferUntilTransactionCommitSucceeds(transaction, callbacks);
    await transaction.commit();

    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not run callbacks when the transaction commit fails', async () => {
    const transaction = createTransaction();
    const callback = vi.fn();
    transaction.commit.mockRejectedValueOnce(new Error('commit failed'));

    deferUntilTransactionCommitSucceeds(transaction, [callback]);

    await expect(transaction.commit()).rejects.toThrow('commit failed');
    expect(callback).not.toHaveBeenCalled();
  });

  it('reuses the wrapped transaction and retains callbacks after a failed commit', async () => {
    const transaction = createTransaction();
    const firstCallback = vi.fn();
    const secondCallback = vi.fn();
    transaction.commit.mockRejectedValueOnce(new Error('commit failed'));
    transaction.commit.mockResolvedValueOnce(undefined);

    deferUntilTransactionCommitSucceeds(transaction, [firstCallback]);
    const wrappedCommit = transaction.commit;

    await expect(transaction.commit()).rejects.toThrow('commit failed');
    deferUntilTransactionCommitSucceeds(transaction, [secondCallback]);

    expect(transaction.commit).toBe(wrappedCommit);
    await expect(transaction.commit()).resolves.toBeUndefined();
    expect(firstCallback).toHaveBeenCalledOnce();
    expect(secondCallback).toHaveBeenCalledOnce();
  });

  it('keeps a committed child successful when callback migration to its parent fails', async () => {
    const child = createTransaction({});
    const callback = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      deferUntilTransactionCommitSucceeds(child, [callback]);

      await expect(child.commit()).resolves.toBeUndefined();
      expect(callback).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        CALLBACK_FAILURE,
        expect.objectContaining({
          message: 'External approval transaction must expose a commit method',
        }),
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
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

      expect(consoleErrorSpy).toHaveBeenCalledWith(CALLBACK_FAILURE, expect.any(AggregateError));
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

    expect(rootReporter).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'root callback failed',
      }),
    );
    expect(childReporter).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'child callback failed',
      }),
    );
  });

  it('keeps commits successful when callback error reporting fails', async () => {
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
      expect(consoleErrorSpy).toHaveBeenCalledWith(DEFERRED_REPORTING_FAILURE, expect.any(Error));
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
      expect(consoleErrorSpy).toHaveBeenCalledWith(CALLBACK_FAILURE, expect.any(Error));
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});

describe('runDeferredAfterCommitCallbacks', () => {
  it('reports callback failures through the configured handler', async () => {
    const callbackError = new Error('callback failed');
    const errorHandler = vi.fn();

    await expect(
      runDeferredAfterCommitCallbacks(
        [
          async () => {
            throw callbackError;
          },
        ],
        errorHandler,
      ),
    ).resolves.toBeUndefined();

    expect(errorHandler).toHaveBeenCalledOnce();
    expect(errorHandler).toHaveBeenCalledWith(callbackError);
  });

  it('throws the original callback failure when no handler is configured', async () => {
    const callbackError = new Error('callback failed');

    await expect(
      runDeferredAfterCommitCallbacks([
        async () => {
          throw callbackError;
        },
      ]),
    ).rejects.toBe(callbackError);
  });

  it('contains handler failures while reporting callback errors', async () => {
    const reportError = new Error('report failed');
    const errorHandler = vi.fn().mockRejectedValue(reportError);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await expect(
        runDeferredAfterCommitCallbacks(
          [
            async () => {
              throw new Error('callback failed');
            },
          ],
          errorHandler,
        ),
      ).resolves.toBeUndefined();
      expect(errorHandler).toHaveBeenCalledOnce();
      expect(consoleErrorSpy).toHaveBeenCalledWith(DEFERRED_REPORTING_FAILURE, reportError);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
