export type DeferredAfterCommit = () => unknown | Promise<unknown>;

type TransactionState = {
  callbacks: DeferredAfterCommit[];
};

const transactionStates = new WeakMap<object, TransactionState>();

export async function runDeferredAfterCommitCallbacks(callbacks: DeferredAfterCommit[]) {
  const pendingCallbacks = callbacks.splice(0);
  const errors: unknown[] = [];
  for (const callback of pendingCallbacks) {
    try {
      await callback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'Deferred after-commit callbacks failed');
  }
}

export function deferUntilTransactionCommitSucceeds(transaction, callbacks: DeferredAfterCommit[]) {
  if (!callbacks.length) {
    return;
  }

  if (typeof transaction?.commit !== 'function') {
    throw new Error('External approval transaction must expose a commit method');
  }

  let state = transactionStates.get(transaction);
  if (!state) {
    state = { callbacks: [] };
    transactionStates.set(transaction, state);

    const commit = transaction.commit.bind(transaction);
    const rollback = transaction.rollback?.bind(transaction);

    // Sequelize runs native afterCommit hooks even when commit rejects. Drain this queue only after commit resolves.
    transaction.commit = async () => {
      try {
        const result = await commit();
        const pendingCallbacks = state.callbacks.splice(0);
        if (transaction.parent) {
          deferUntilTransactionCommitSucceeds(transaction.parent, pendingCallbacks);
        } else {
          await runDeferredAfterCommitCallbacks(pendingCallbacks);
        }
        return result;
      } finally {
        transactionStates.delete(transaction);
        state.callbacks.splice(0);
      }
    };

    if (rollback) {
      transaction.rollback = async () => {
        try {
          return await rollback();
        } finally {
          state.callbacks.splice(0);
          transactionStates.delete(transaction);
        }
      };
    }
  }

  state.callbacks.push(...callbacks.splice(0));
}
