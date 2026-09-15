/**
 * Whether one coordination message is admitted far enough to be MIRRORED.
 *
 * Admission is not belief. A message that passes every check here has earned
 * exactly one thing: the right to be written into the delivery journal as an
 * observation-only mirror record. It has not satisfied an obligation, moved a
 * state, or authorized anything. That ceiling is the unit's whole point, so it
 * is stated at the top of the decision rather than left to the caller.
 *
 * The checks are ordered cheapest-and-most-structural first, and NOTHING
 * short-circuits: the verdict carries every refusal the message earned, so a
 * forged cross-repository replay on an unsupported protocol reports all three
 * rather than only the first. A refusal corpus that reports one code per
 * message is a corpus that cannot tell you whether the other checks ran.
 */

import { validateCoordinationMessage, type CoordinationMessage, COORDINATION_PROTOCOL_VERSION } from "./message.ts";

/**
 * Why a message was refused. These are this unit's own codes: the spine's
 * rejection vocabulary is frozen and describes durable journal entries, not
 * wire messages, and widening it to carry transport refusals would put the
 * control plane's vocabulary inside the contract spine.
 */
export const COORDINATION_REFUSALS = Object.freeze([
  "message_malformed",
  "protocol_unsupported",
  "channel_unrecognized",
  "trust_root_confusion",
  "repository_scope_mismatch",
  "delivery_scope_mismatch",
  "nonce_replayed",
  "sequence_regressed",
  "authority_not_local",
] as const);
export type CoordinationRefusalCode = (typeof COORDINATION_REFUSALS)[number];

export interface CoordinationRefusal {
  readonly code: CoordinationRefusalCode;
  readonly pointer: string;
  readonly message: string;
}

/**
 * What the installation locally knows, supplied by the caller. Every member is
 * derived from local state — the trust store, the compiled policy, the
 * delivery journal — and none of it is ever taken from a message. A view that
 * could be populated from the wire would make every check below circular.
 */
export interface CoordinationAdmissionView {
  readonly repositoryId: string;
  readonly deliveryId: string;
  /** Connector-provisioned key ids this installation trusts, from local config. */
  readonly trustedKeyIds: readonly string[];
  /** Channel digests currently established, from the transport. */
  readonly establishedChannelDigests: readonly string[];
  /**
   * The release-signing trust root's key ids. A coordination key that is also
   * a release-signing key is refused outright rather than accepted: the
   * ticket requires connector keys DISTINCT from the release-signing trust
   * root, and the only way to enforce distinctness is to refuse the overlap
   * where it is observable.
   */
  readonly releaseSigningKeyIds: readonly string[];
  /** The replay ledger: nonces already mirrored for this delivery. */
  readonly consumedNonces: ReadonlySet<string>;
  /**
   * The highest sequence already mirrored on this channel, or -1 when none
   * has been. A message at or below it is a duplicate or a reordering, and is
   * refused rather than applied — the mirror is an append-only record, so a
   * message that arrives twice must not be written twice.
   */
  readonly highestSequence: number;
  /**
   * Whether local authority exists for a remotely-notified approval or
   * cancellation. This is decided by the local approval lane — never by the
   * message — and is passed in as a value rather than imported so that this
   * unit cannot reach into the approval model and re-author it.
   */
  readonly approvalAuthorityIsLocallyValid: boolean;
}

export type CoordinationAdmission =
  | { readonly ok: true; readonly message: CoordinationMessage }
  | { readonly ok: false; readonly refusals: readonly CoordinationRefusal[] };

const refusal = (code: CoordinationRefusalCode, pointer: string, message: string): CoordinationRefusal => ({
  code,
  pointer,
  message,
});

/**
 * The kinds that carry a decision the local delivery would otherwise have to
 * make for itself. They are the only ones gated on local approval authority,
 * because they are the only ones a control plane could use to short-circuit
 * a human decision.
 */
const AUTHORITY_BEARING_CLAIMS: ReadonlySet<string> = new Set(["approval-notified", "cancelled"]);

export function admitCoordinationMessage(value: unknown, view: CoordinationAdmissionView): CoordinationAdmission {
  const shape = validateCoordinationMessage(value);
  if (!shape.ok) {
    return {
      ok: false,
      refusals: shape.rejections.map((rejection) =>
        refusal("message_malformed", rejection.pointer, `${rejection.code}: ${rejection.message}`),
      ),
    };
  }
  const message = value as CoordinationMessage;
  const refusals: CoordinationRefusal[] = [];

  if (message.protocolVersion !== COORDINATION_PROTOCOL_VERSION) {
    refusals.push(
      refusal(
        "protocol_unsupported",
        "/protocolVersion",
        `this product speaks ${COORDINATION_PROTOCOL_VERSION}; a peer speaking ${message.protocolVersion} is refused rather than partially understood`,
      ),
    );
  }

  const { keyId, channelDigest } = message.authentication;
  if (view.releaseSigningKeyIds.includes(keyId)) {
    refusals.push(
      refusal(
        "trust_root_confusion",
        "/authentication/keyId",
        "a coordination key must be distinct from the release-signing trust root; a key serving both roles would let the control plane speak with release authority",
      ),
    );
  }
  // Not `else if`: a key that is BOTH the release-signing root and absent from
  // the trusted connector set earned two distinct refusals, and the header's
  // no-short-circuit rule is a rule, not a description. Suppressing the second
  // here would produce exactly the corpus that rule exists to prevent — one
  // that cannot tell a reader whether the trusted-key check ran at all.
  if (!view.trustedKeyIds.includes(keyId)) {
    refusals.push(
      refusal("channel_unrecognized", "/authentication/keyId", "no connector-provisioned key with this id is trusted by this installation"),
    );
  }
  if (!view.establishedChannelDigests.includes(channelDigest)) {
    refusals.push(
      refusal(
        "channel_unrecognized",
        "/authentication/channelDigest",
        "the message is not bound to an established mutually authenticated channel; a valid key id on an unbound channel is a replay",
      ),
    );
  }

  if (message.repositoryId !== view.repositoryId) {
    refusals.push(
      refusal("repository_scope_mismatch", "/repositoryId", "the message is scoped to a different repository"),
    );
  }
  if (message.deliveryId !== view.deliveryId) {
    refusals.push(refusal("delivery_scope_mismatch", "/deliveryId", "the message is scoped to a different delivery"));
  }

  if (view.consumedNonces.has(message.nonce)) {
    refusals.push(refusal("nonce_replayed", "/nonce", "this nonce has already been mirrored for this delivery"));
  }
  if (message.sequence <= view.highestSequence) {
    refusals.push(
      refusal(
        "sequence_regressed",
        "/sequence",
        `sequence ${message.sequence} is not above the highest already mirrored (${view.highestSequence}); duplicates and reorderings are refused, never applied`,
      ),
    );
  }

  if (AUTHORITY_BEARING_CLAIMS.has(message.claim) && !view.approvalAuthorityIsLocallyValid) {
    refusals.push(
      refusal(
        "authority_not_local",
        "/claim",
        "a remotely notified approval or cancellation carries no authority of its own; it is admitted only when the local approval lane independently holds valid authority",
      ),
    );
  }

  return refusals.length === 0 ? { ok: true, message } : { ok: false, refusals };
}

/**
 * A mirror record as far as the replay ledger needs to read one back.
 * Structural on purpose: the frozen payload carries all three members, and
 * this unit neither imports the journal store nor restates its grammar.
 */
export interface MirroredMessageView {
  readonly nonce: string;
  readonly channelDigest: string;
  readonly remoteSequence: number;
}

/** The two replay-protection members of an admission view, rebuilt from the journal. */
export interface CoordinationReplayLedger {
  readonly consumedNonces: ReadonlySet<string>;
  readonly highestSequence: number;
}

/**
 * Rebuilds the replay ledger from the delivery journal's own mirror records.
 *
 * This exists because the two members it produces are the only parts of the
 * admission view that must survive a restart, and saying so in a comment is
 * not a mechanism. Round 3 found the durable record carrying neither a nonce
 * nor the channel digest, which made the ledger unrebuildable: after a
 * reconnect every replayed nonce would have been admitted again, and the
 * high-water mark could only be rebuilt per KEY while it is defined per
 * CHANNEL — conflating two channels that share one connector key.
 *
 * It is scoped to one channel deliberately. `highestSequence` is documented as
 * "the highest sequence already mirrored on THIS channel", and a mark pooled
 * across channels both refuses legitimate traffic on the slower one and admits
 * a replay captured from the faster one.
 */
export function replayLedgerOf(
  records: readonly MirroredMessageView[],
  channelDigest: string,
): CoordinationReplayLedger {
  const onThisChannel = records.filter((record) => record.channelDigest === channelDigest);
  return {
    // Nonces are single-use within a channel, so the ledger is channel-scoped
    // here too; a nonce reused across two channels is two different messages.
    consumedNonces: new Set(onThisChannel.map((record) => record.nonce)),
    highestSequence: onThisChannel.reduce((highest, record) => Math.max(highest, record.remoteSequence), -1),
  };
}
