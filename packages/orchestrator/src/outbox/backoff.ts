export interface RetryPolicy {
  /** Delivery attempts per cycle before dead-lettering (a redrive starts a new cycle). */
  maxAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

/**
 * Exponential backoff with "equal jitter": the delay before retry n (n = failed attempts so far,
 * 1-based) is uniformly distributed in [cap/2, cap], where cap = min(max, base * 2^(n-1)).
 * Keeping half the delay fixed avoids near-zero retries; the random half spreads out retries
 * from many workers failing at once.
 */
export function computeBackoffMs(
  failedAttempts: number,
  policy: Pick<RetryPolicy, "backoffBaseMs" | "backoffMaxMs">,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, failedAttempts - 1);
  const cap = Math.min(policy.backoffMaxMs, policy.backoffBaseMs * 2 ** exponent);
  return Math.round(cap / 2 + random() * (cap / 2));
}
