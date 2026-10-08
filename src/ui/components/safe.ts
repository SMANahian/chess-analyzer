// Reads for the app shell (nav badges, the recovery screen): a stored row that makes a computed view
// throw must not take the whole app down with it, so these fall back instead of throwing.
import * as store from '../../state/store';

const reported = new WeakSet<object>();

/** read(), or `fallback` when it throws (the error is logged once). */
export function safeRead<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch (err) {
    if (typeof err !== 'object' || err === null || !reported.has(err)) {
      if (typeof err === 'object' && err !== null) reported.add(err);
      console.error('A view of the stored data failed; showing a fallback.', err);
    }
    return fallback;
  }
}

export const NO_TRAINING: store.TrainingCounts = { dueReviews: 0, newAvailable: 0, total: 0 };

/** store.trainingCounts, or zeros when the training views cannot be computed. */
export function trainingCountsSafe(): store.TrainingCounts {
  return safeRead(() => store.trainingCounts.value, NO_TRAINING);
}
