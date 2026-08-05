export type DeferredAfterCommit = () => unknown | Promise<unknown>;
export type DeferredAfterCommitErrorHandler = (error: unknown) => unknown | Promise<unknown>;

type TransactionState = {
  callbacks: DeferredAfterCommit[];
  errorHandler?: DeferredAfterCommitErrorHandler;
};

const transactionStates = new WeakMap<object, TransactionState>();

async function reportDeferredAfterCommitError(error: unknown, errorHandler?: DeferredAfterCommitErrorHandler) {
  try {
    if (errorHandler) {
      await errorHandler(error);
    } else {
      console.error('Deferred after-commit callbacks failed', error);
    }
  } catch (reportError) {
    console.error('Deferred after-commit error reporting failed', reportError);
  }
}

export async function runDeferredAfterCommitCallbacks(
  callbacks: DeferredAfterCommit[],
  errorHandler?: DeferredAfterCommitErrorHandler,
) {
  const pendingCallbacks = callbacks.splice(0);
  const errors: unknown[] = [];
  for (const callback of pendingCallbacks) {
    try {
      await callback();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) {
    const error =
      errors.length === 1 ? errors[0] : new AggregateError(errors, 'Deferred after-commit callbacks failed');
    if (errorHandler) {
      await errorHandler(error);
    } else {
      throw error;
    }
  }
}

export function deferUntilTransactionCommitSucceeds(
  transaction,
  callbacks: DeferredAfterCommit[],
  errorHandler?: DeferredAfterCommitErrorHandler,
) {
  if (!callbacks.length) {
    return;
  }

  if (typeof transaction?.commit !== 'function') {
    throw new Error('External approval transaction must expose a commit method');
  }

  let state = transactionStates.get(transaction);
  if (!state) {
    state = { callbacks: [], errorHandler };
    transactionStates.set(transaction, state);

    const commit = transaction.commit.bind(transaction);
    const rollback = transaction.rollback?.bind(transaction);

    // Sequelize runs native afterCommit hooks even when commit rejects. Drain this queue only after commit resolves.
    transaction.commit = async () => {
      try {
        const result = await commit();
        const pendingCallbacks = state.callbacks.splice(0);
        if (transaction.parent) {
          deferUntilTransactionCommitSucceeds(transaction.parent, pendingCallbacks, state.errorHandler);
        } else {
          try {
            await runDeferredAfterCommitCallbacks(pendingCallbacks, state.errorHandler);
          } catch (error) {
            await reportDeferredAfterCommitError(error, state.errorHandler);
          }
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

  if (!state.errorHandler && errorHandler) {
    state.errorHandler = errorHandler;
  }
  state.callbacks.push(...callbacks.splice(0));
}
