export type DeferredAfterCommit = () => unknown | Promise<unknown>;
export type DeferredAfterCommitErrorHandler = (error: unknown) => unknown | Promise<unknown>;

type AfterCommitErrorHandler = DeferredAfterCommitErrorHandler;

type DeferredAfterCommitRegistration = {
  callback: DeferredAfterCommit;
  errorHandler?: DeferredAfterCommitErrorHandler;
};

type TransactionState = {
  callbacks: DeferredAfterCommitRegistration[];
  rollbackCallbacks: DeferredAfterCommit[];
};

const transactionStates = new WeakMap<object, TransactionState>();
const CALLBACK_ERROR = 'Deferred after-commit callbacks failed';

async function reportDeferredAfterCommitError(error: unknown, handler?: AfterCommitErrorHandler) {
  try {
    if (handler) {
      await handler(error);
    } else {
      console.error(CALLBACK_ERROR, error);
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
    const error = errors.length === 1 ? errors[0] : new AggregateError(errors, CALLBACK_ERROR);
    if (errorHandler) {
      await reportDeferredAfterCommitError(error, errorHandler);
    } else {
      throw error;
    }
  }
}

async function runDeferredAfterCommitRegistrations(registrations: DeferredAfterCommitRegistration[]) {
  const errorsWithoutHandlers: unknown[] = [];
  for (const { callback, errorHandler } of registrations) {
    try {
      await callback();
    } catch (error) {
      if (errorHandler) {
        await reportDeferredAfterCommitError(error, errorHandler);
      } else {
        errorsWithoutHandlers.push(error);
      }
    }
  }

  if (errorsWithoutHandlers.length) {
    const error =
      errorsWithoutHandlers.length === 1
        ? errorsWithoutHandlers[0]
        : new AggregateError(errorsWithoutHandlers, CALLBACK_ERROR);
    await reportDeferredAfterCommitError(error);
  }
}

async function runDeferredRollbackCallbacks(callbacks: DeferredAfterCommit[]) {
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      console.error('Deferred rollback callback failed', error);
    }
  }
}

function registerDeferredCallbacks(
  transaction,
  registrations: DeferredAfterCommitRegistration[],
  rollbackCallbacks: DeferredAfterCommit[],
) {
  if (!registrations.length && !rollbackCallbacks.length) {
    return;
  }

  if (typeof transaction?.commit !== 'function') {
    throw new Error('External approval transaction must expose a commit method');
  }

  let state = transactionStates.get(transaction);
  if (!state) {
    state = { callbacks: [], rollbackCallbacks: [] };

    const originalCommit = transaction.commit;
    const originalRollback = transaction.rollback;
    const commit = originalCommit.bind(transaction);
    const rollback = originalRollback?.bind(transaction);

    // Sequelize runs native afterCommit hooks even when commit rejects.
    // Drain this queue only after commit resolves.
    const wrappedCommit = async () => {
      const result = await commit();
      try {
        const pendingCallbacks = state.callbacks.splice(0);
        const pendingRollbackCallbacks = state.rollbackCallbacks.splice(0);
        const parent = transaction.parent;
        if (parent) {
          try {
            registerDeferredCallbacks(parent, pendingCallbacks, pendingRollbackCallbacks);
          } catch (error) {
            await reportDeferredAfterCommitError(error);
          }
        } else {
          await runDeferredAfterCommitRegistrations(pendingCallbacks);
        }
        return result;
      } finally {
        transactionStates.delete(transaction);
        state.callbacks.splice(0);
        state.rollbackCallbacks.splice(0);
      }
    };

    let wrappedRollback;
    if (rollback) {
      wrappedRollback = async () => {
        const shouldRunCallbacks = !transaction.finished;
        const pendingCallbacks = shouldRunCallbacks ? state.rollbackCallbacks.splice(0) : [];
        try {
          return await rollback();
        } finally {
          state.callbacks.splice(0);
          state.rollbackCallbacks.splice(0);
          transactionStates.delete(transaction);
          await runDeferredRollbackCallbacks(pendingCallbacks);
        }
      };
    }

    try {
      transaction.commit = wrappedCommit;
      if (wrappedRollback) {
        transaction.rollback = wrappedRollback;
      }
    } catch (error) {
      try {
        transaction.commit = originalCommit;
      } catch {}
      if (wrappedRollback) {
        try {
          transaction.rollback = originalRollback;
        } catch {}
      }
      throw error;
    }
    transactionStates.set(transaction, state);
  }

  state.callbacks.push(...registrations);
  state.rollbackCallbacks.push(...rollbackCallbacks);
}

export function deferUntilTransactionCommitSucceeds(
  transaction,
  callbacks: DeferredAfterCommit[],
  errorHandler?: DeferredAfterCommitErrorHandler,
  rollbackCallback?: DeferredAfterCommit,
) {
  if (!callbacks.length && !rollbackCallback) {
    return;
  }

  const registrations = callbacks.map((callback) => ({ callback, errorHandler }));
  const rollbackCallbacks = rollbackCallback ? [rollbackCallback] : [];
  registerDeferredCallbacks(transaction, registrations, rollbackCallbacks);
  callbacks.splice(0);
}
