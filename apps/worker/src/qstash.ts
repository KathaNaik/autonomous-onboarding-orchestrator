import { Receiver } from "@upstash/qstash";

export const QSTASH_SIGNATURE_HEADER = "upstash-signature";

export interface QStashVerifier {
  /** true only for a valid signature over exactly `body`, for exactly the configured URL. */
  verify(input: { signature: string | undefined; body: string }): Promise<boolean>;
}

/**
 * (M10) Authenticates scheduled deliveries with the official QStash Receiver: the
 * Upstash-Signature JWT (HS256, issuer Upstash) must verify with the current or the next
 * signing key (rotation), be inside its exp/nbf window, name this worker URL as its subject and
 * carry the SHA-256 of the exact raw body. Never throws; never exposes why verification failed.
 */
export function createQStashVerifier(options: {
  currentSigningKey: string;
  nextSigningKey: string;
  url: string;
  clockToleranceSeconds?: number;
}): QStashVerifier {
  // devMode false: never fall back to QStash's public local-development keys, and both keys are
  // passed explicitly so nothing is read from the environment.
  const receiver = new Receiver({
    currentSigningKey: options.currentSigningKey,
    nextSigningKey: options.nextSigningKey,
    devMode: false,
  });
  return {
    async verify({ signature, body }) {
      if (!signature || signature.length > 8192) return false;
      try {
        return await receiver.verify({
          signature,
          body,
          url: options.url,
          clockTolerance: options.clockToleranceSeconds ?? 0,
        });
      } catch {
        return false;
      }
    },
  };
}
