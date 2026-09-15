/**
 * The coordination contract family: the versioned message grammar an optional
 * hosted control plane speaks to this product, and nothing else.
 *
 * The family is deliberately absent from the frozen spine. The spine owns the
 * durable journal; this unit owns the wire. Keeping them apart is what lets a
 * later protocol revision ship without a spine contract revision — and it is
 * why the only thing this unit puts INTO the spine is one mirror record whose
 * payload is a projection of a message, never the message itself.
 *
 * Three rules shape every grammar here:
 *
 *  1. **Closed tables.** A stranger member rejects. The closed table is also
 *     the first redaction rule: a message has no free-form member for a dump,
 *     a transcript, or a credential to land in. The one bounded free-text
 *     member is named `summary` precisely so that the durable path's existing
 *     secret discipline — which redacts inside `summary` and `reason` and
 *     rejects everywhere else — applies to it without this unit re-authoring
 *     a redaction rule of its own.
 *  2. **No secret crosses this boundary.** Authentication is carried as a
 *     `keyId` REFERENCE, exactly as adapter credentials are. A key's bytes
 *     are resolved outside the kernel and never reach a message, a journal, or
 *     a log. `validateCoordinationMessage` rejects a member that looks like a
 *     key rather than a reference.
 *  3. **The control plane asserts; it never concludes.** Every message kind
 *     here is either a request the host may refuse or a claim the local
 *     delivery may contradict. There is no message kind that completes an
 *     obligation, advances a state, or satisfies evidence, because a grammar
 *     that could express one would eventually be believed.
 */

import {
  boundedText,
  checkClosed,
  closed,
  createSpineCollector,
  nonNegativeInt,
  oneOf,
  sha256,
  specLiteral,
  spineId,
  text,
  type MemberRule,
  type SpineVerdict,
  isSpineRecord,
} from "../spine/grammar.ts";
import { CONTROL_PLANE_CLAIM_KINDS } from "../spine/journal.ts";
import { firstSecretIn } from "../checkpoint/redaction.ts";

export const COORDINATION_MESSAGE_SPEC = "coordination-message/1";

/**
 * The protocol version this product implements. It versions the WIRE, not the
 * hosted service: a peer speaking a different version is refused rather than
 * partially understood, which is the only safe reading when the peer is the
 * party with an incentive to be believed.
 */
export const COORDINATION_PROTOCOL_VERSION = "control-plane-coordination/1";

/**
 * The five message kinds, verbatim from the unit's scope.
 *
 * `enqueue`, `host.start.requested` and `approval.notified` are REQUESTS: the
 * host may satisfy or refuse each one, and refusing is not an error. `mirror`
 * and `terminal.projection` are CLAIMS about what the control plane believes
 * happened; both are reconciled against local history and neither is ever
 * applied.
 *
 * There is deliberately no `cancel` kind. A remote cancellation is expressed
 * as an `approval.notified` message carrying a cancellation decision, so that
 * it travels the same authority check as every other approval and cannot
 * reach a shorter path.
 */
export const COORDINATION_MESSAGE_KINDS = Object.freeze([
  "enqueue",
  "mirror",
  "host.start.requested",
  "approval.notified",
  "terminal.projection",
] as const);
export type CoordinationMessageKind = (typeof COORDINATION_MESSAGE_KINDS)[number];

/**
 * What the control plane claims about a delivery.
 *
 * The list is IMPORTED from the frozen journal payload table, not restated
 * here. The mirror record is a durable journal payload, so its vocabulary
 * belongs to the spine; re-declaring it on the wire side would let the two
 * drift, and a wire that could express a claim the journal cannot record is a
 * wire whose messages are admitted and then undurable.
 *
 * `advanced`, `completed` and `cancelled` are the three that can contradict
 * local history; the rest are observations about the control plane's own
 * queue and carry no claim about local work.
 */
export const CONTROL_PLANE_CLAIMS = CONTROL_PLANE_CLAIM_KINDS;
export type ControlPlaneClaim = (typeof CONTROL_PLANE_CLAIM_KINDS)[number];

/**
 * The transport-level authentication a message carries. This is a REFERENCE
 * pair, never key material: `keyId` names a connector-provisioned key the
 * installation already trusts, and `channelDigest` binds the message to the
 * mutually authenticated channel it arrived on, so a message replayed onto a
 * different channel does not verify even with a valid key id.
 *
 * The bytes behind `keyId` live outside the kernel. Nothing in this unit can
 * read them, and nothing needs to: this unit decides SCOPE and FRESHNESS from
 * references, and leaves cryptographic verification to the transport that
 * established the channel.
 */
export interface CoordinationAuthentication {
  readonly keyId: string;
  readonly channelDigest: string;
}

export interface CoordinationMessage {
  readonly spec: typeof COORDINATION_MESSAGE_SPEC;
  readonly protocolVersion: string;
  readonly messageId: string;
  /** Single-use within a channel; the replay ledger is the local journal. */
  readonly nonce: string;
  /** Per-(channel, delivery) monotonic counter; a regression is a replay. */
  readonly sequence: number;
  readonly repositoryId: string;
  readonly deliveryId: string;
  readonly kind: CoordinationMessageKind;
  readonly claim: ControlPlaneClaim;
  readonly authentication: CoordinationAuthentication;
  /** Bounded, redactable, and the only free-form member in the family. */
  readonly summary: string;
}

/**
 * A peer-authored identity: a spine id that is a REFERENCE and not credential
 * material. This is header rule 2 made mechanical — "`validateCoordinationMessage`
 * rejects a member that looks like a key rather than a reference".
 *
 * It matters here rather than only at the durable append. `SPINE_ID` admits
 * `_`, `-` and `.`, so seven of the nine corpus patterns are expressible as a
 * valid spine id, and `messageId` and `nonce` are authored entirely by the
 * peer. The durable path's secret discipline REJECTS a secret in a structural
 * member — correctly — which means a peer that shapes its own message id like
 * a token can make the mirror record unappendable at will. Round 5 found what
 * that buys the peer: the reconciliation still owes an advancing
 * `blocker.recorded`, that append carries no peer-authored member and lands,
 * and the mirror record that carries the coalescing window and the replay
 * ledger's nonce does not — so the window never closes, every further
 * contradiction costs another advancing blocker, and the nonce is never
 * consumed. Refusing the message here, before anything is owed, is the only
 * point at which nothing has yet been done on the strength of it.
 *
 * The same rule is applied to every reference member the peer authors, not
 * just the two that reach the durable payload: a reference member is never
 * legitimately credential-shaped, and a rule that held for two of five would
 * be a rule a reader could not state.
 */
const reference: MemberRule["check"] = (value, at, collector) => {
  spineId(value, at, collector);
  if (typeof value !== "string") return;
  const secret = firstSecretIn(value);
  if (secret !== undefined) {
    collector.emit(
      "malformed_member",
      at,
      `this member is a reference, never key material; the value carries a ${secret} shape`,
    );
  }
};

const AUTHENTICATION_RULES: readonly MemberRule[] = [
  { name: "keyId", check: reference },
  { name: "channelDigest", check: sha256 },
];

const MESSAGE_RULES: readonly MemberRule[] = [
  { name: "spec", check: specLiteral(COORDINATION_MESSAGE_SPEC) },
  // `text`, not `spineId`: a protocol version is a spec-style identity
  // carrying a slash ("control-plane-coordination/1"), and it is the PEER's
  // claim about itself — the value must be able to hold a version this
  // product does not implement, because refusing it by name is the whole
  // point of `protocol_unsupported`.
  { name: "protocolVersion", check: text },
  { name: "messageId", check: reference },
  { name: "nonce", check: reference },
  { name: "sequence", check: nonNegativeInt },
  { name: "repositoryId", check: reference },
  { name: "deliveryId", check: reference },
  { name: "kind", check: oneOf(COORDINATION_MESSAGE_KINDS) },
  { name: "claim", check: oneOf(CONTROL_PLANE_CLAIMS) },
  { name: "authentication", check: closed(AUTHENTICATION_RULES) },
  { name: "summary", check: boundedText },
];

/**
 * Validates one message against the closed family grammar. Shape only: this
 * says the message is well-formed and says nothing whatever about whether it
 * is authorized, fresh, or true. Those are three separate decisions in
 * `admission.ts`, kept separate so that no caller can mistake a well-formed
 * message for an accepted one.
 */
export function validateCoordinationMessage(value: unknown): SpineVerdict {
  const collector = createSpineCollector();
  if (!isSpineRecord(value)) {
    collector.emit("not_an_object", "", "expected a JSON object");
    return collector.verdict();
  }
  checkClosed(value, "", MESSAGE_RULES, collector);
  return collector.verdict();
}
