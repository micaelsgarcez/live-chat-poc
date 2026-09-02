/**
 * Failure classification.
 *
 * The client is told *which* check failed and nothing else. Keeping the
 * vocabulary closed is the point: jose's messages quote claim values and key
 * material details, and those must never reach a 401 body.
 *
 * Internal to the auth slice — other slices import `./index.ts` only.
 */
import { errors } from "jose";
import { JwksUnavailableError } from "./jwks";

export type AuthFailureReason =
  | "expired"
  | "bad_signature"
  | "wrong_audience"
  | "wrong_issuer"
  | "malformed"
  | "not_configured";

export function classifyVerifyError(error: unknown): AuthFailureReason {
  if (error instanceof errors.JWTExpired) return "expired";

  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "aud") return "wrong_audience";
    if (error.claim === "iss") return "wrong_issuer";
    // `nbf`, `sub`, a missing `exp`: the holder's only move is to get a new
    // token, and naming the claim would help someone map the validation rules.
    return "malformed";
  }

  // An unknown `kid` after a forced reload means the signature cannot be tied
  // to any key we trust — indistinguishable, from the client's side, from a
  // signature that simply does not verify.
  if (
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  ) {
    return "bad_signature";
  }

  // Our side is broken, not the token's.
  if (error instanceof JwksUnavailableError || error instanceof errors.JWKSTimeout) {
    return "not_configured";
  }

  return "malformed";
}
