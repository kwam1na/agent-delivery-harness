/**
 * The deterministic control-plane simulator.
 *
 * It is a shipped module rather than a test helper because the ticket's
 * compounding claim depends on it: the simulator doubles as the conformance
 * kit a real hosted control plane is later checked against. A kit that lived
 * in a test file could not be run against anything else.
 *
 * It follows the fake host's convention exactly: every decision it reports is
 * produced by the REAL decision modules — `admitCoordinationMessage` and
 * `reconcileRemoteClaim` — and only the mechanism is stubbed. A simulator that
 * re-implemented the rules would be a second, weaker implementation, and the
 * qualification it produced would be worth nothing.
 *
 * There is no clock and no randomness. Sequence numbers, nonces and message
 * ids are derived from a caller-supplied counter, so an identical script
 * produces an identical transcript on every host.
 */

import { admitCoordinationMessage, type CoordinationAdmissionView, type CoordinationAdmission } from "./admission.ts";
import {
  COORDINATION_MESSAGE_SPEC,
  COORDINATION_PROTOCOL_VERSION,
  type ControlPlaneClaim,
  type CoordinationAuthentication,
  type CoordinationMessage,
  type CoordinationMessageKind,
} from "./message.ts";
import { reconcileRemoteClaim, type LocalHistoryView, type ClaimReconciliation } from "./reconcile.ts";
import { UNBOUND_COORDINATION_PORT, type CoordinationDispatch, type CoordinationPort } from "./port.ts";

export interface SimulatedMessageOptions {
  /**
   * The message id is overridable like every other member, and it was a fixed
   * constant until round 9 found the comment on `mint` claiming otherwise: a
   * kit whose corpus cannot bend `messageId` cannot mint the very vector this
   * delivery's round-5 finding turns on — a peer that shapes its own message
   * id like a credential — and a corpus that has to reach around the kit for
   * its most important vector is not qualifying the kit.
   *
   * `spec` is the one member that is deliberately NOT here, and not by
   * oversight: `CoordinationMessage["spec"]` is the literal
   * `COORDINATION_MESSAGE_SPEC`, so a message carrying any other value is not
   * a `CoordinationMessage` at all and `mint` could not return one. A foreign
   * envelope is minted by spreading a minted message, and it is refused by the
   * grammar, which takes `unknown` precisely so that vector can be expressed;
   * `unsupported_spec` is pinned there.
   */
  readonly messageId?: string;
  readonly kind?: CoordinationMessageKind;
  readonly claim?: ControlPlaneClaim;
  readonly sequence?: number;
  readonly nonce?: string;
  readonly repositoryId?: string;
  readonly deliveryId?: string;
  readonly keyId?: string;
  readonly channelDigest?: string;
  readonly protocolVersion?: string;
  readonly summary?: string;
}

/**
 * Every member of the WIRE a corpus is allowed to bend, flattened: the message's
 * own members except `spec`, plus the two members of its authentication block.
 *
 * `spec` is the one exclusion and it is structural rather than chosen:
 * `CoordinationMessage["spec"]` is the literal `COORDINATION_MESSAGE_SPEC`, so
 * a message carrying any other value is not a `CoordinationMessage` and `mint`
 * could not return one. The foreign-envelope vector belongs to the grammar,
 * which takes `unknown`.
 */
type BendableWireMember =
  | Exclude<keyof CoordinationMessage, "spec" | "authentication">
  | keyof CoordinationAuthentication;

/**
 * Every declared override, as a value rather than only as a type — and, with
 * the row that reads it, what ties the kit's override surface to the wire in
 * both directions.
 *
 * The record is typed over `Required<SimulatedMessageOptions>` intersected with
 * `BendableWireMember`, and it is an object literal, so two drifts are compile
 * errors AT THIS DECLARATION: a member added to the WIRE and not declared here,
 * and a key here that is neither a wire member nor an option.
 *
 * Stated precisely, because round 11 found the first spelling of this comment
 * claiming a third: a member REMOVED from the options interface is not caught
 * here, and the intersection is why. The required key set is the UNION of the
 * two mapped types, and every option name is also a wire member, so the wire
 * half keeps supplying the key. That edit is caught one step away — at `mint`'s
 * `overrides.<name>`, or, if the author hardcodes the default there too, by the
 * row "honours every override it declares, and declares every member of the
 * message", which goes red on the ignored override. The guarantee holds; the
 * claim that this record alone holds it did not, and a comment that overstates
 * where a guard lives sends the next reader to the wrong place.
 *
 * One more case the type cannot see, found the same round: a new TOP-LEVEL wire
 * member colliding with a name the authentication block already contributes
 * (`keyId`) is not excess here. The runtime half of the row catches it, because
 * it counts the flattened key list off a message the kit actually minted.
 *
 * Why any of this exists: round 9 found six of the ten declared overrides
 * honoured by nothing any row could tell apart from a hardcoded default; round
 * 10 found that the remaining claim — that the kit declares every member of the
 * message — was circular, since "every member" meant "every member we
 * remembered to declare", and a new wire member hardcoded in `mint` left the
 * whole suite green. This type plus that row is what makes the claim answer to
 * the message type instead of to itself.
 */
const OPTION_PRESENCE: { readonly [K in keyof Required<SimulatedMessageOptions>]: true } & {
  readonly [K in BendableWireMember]: true;
} = {
  messageId: true,
  kind: true,
  claim: true,
  sequence: true,
  nonce: true,
  repositoryId: true,
  deliveryId: true,
  keyId: true,
  channelDigest: true,
  protocolVersion: true,
  summary: true,
};

export const SIMULATED_MESSAGE_OPTION_NAMES: readonly (keyof SimulatedMessageOptions)[] = Object.freeze(
  Object.keys(OPTION_PRESENCE) as (keyof SimulatedMessageOptions)[],
);

export interface CoordinationSimulatorOptions {
  readonly repositoryId: string;
  readonly deliveryId: string;
  readonly keyId: string;
  readonly channelDigest: string;
  /** Simulates an outage: while true, every send refuses and receive is empty. */
  readonly offline?: boolean;
}

export interface SimulatedExchange {
  readonly message: CoordinationMessage;
  readonly admission: CoordinationAdmission;
  /** Present only when the message was admitted; a refused message is never reconciled. */
  readonly reconciliation?: ClaimReconciliation;
}

export interface CoordinationSimulator extends CoordinationPort {
  /**
   * Mints a well-formed message; every member is overridable so a corpus can
   * bend exactly one. "Every" is `SIMULATED_MESSAGE_OPTION_NAMES`, which is
   * `OPTION_PRESENCE`'s keys — tied by that record's type to the message's own
   * members, not merely to this interface — and every entry of that list is
   * pinned as actually honoured by "honours every override it declares, and
   * declares every member of the message".
   */
  mint(options?: SimulatedMessageOptions): CoordinationMessage;
  /** Runs one message through the real admission and, if admitted, the real reconciliation. */
  exchange(message: unknown, view: CoordinationAdmissionView, local: LocalHistoryView): SimulatedExchange;
}

const OFFLINE: CoordinationDispatch = {
  ok: false,
  code: "control_plane_unreachable",
  message: "the simulated control plane is offline; the local delivery is unaffected and proceeds",
};

export function createCoordinationSimulator(options: CoordinationSimulatorOptions): CoordinationSimulator {
  let minted = 0;
  const offline = options.offline === true;
  const outbox: CoordinationMessage[] = [];

  const mint = (overrides: SimulatedMessageOptions = {}): CoordinationMessage => {
    minted += 1;
    return {
      spec: COORDINATION_MESSAGE_SPEC,
      protocolVersion: overrides.protocolVersion ?? COORDINATION_PROTOCOL_VERSION,
      messageId: overrides.messageId ?? `sim-message-${minted}`,
      nonce: overrides.nonce ?? `sim-nonce-${minted}`,
      sequence: overrides.sequence ?? minted,
      repositoryId: overrides.repositoryId ?? options.repositoryId,
      deliveryId: overrides.deliveryId ?? options.deliveryId,
      kind: overrides.kind ?? "mirror",
      claim: overrides.claim ?? "enqueued",
      authentication: {
        keyId: overrides.keyId ?? options.keyId,
        channelDigest: overrides.channelDigest ?? options.channelDigest,
      },
      summary: overrides.summary ?? `simulated ${overrides.claim ?? "enqueued"} claim ${minted}`,
    };
  };

  return {
    mint,
    exchange(message, view, local) {
      const admission = admitCoordinationMessage(message, view);
      if (!admission.ok) return { message: message as CoordinationMessage, admission };
      return { message: admission.message, admission, reconciliation: reconcileRemoteClaim(admission.message, local) };
    },
    send(message) {
      if (offline) return Promise.resolve(OFFLINE);
      outbox.push(message);
      return Promise.resolve({ ok: true, message: `queued ${message.messageId}` });
    },
    receive() {
      return Promise.resolve(offline ? [] : [...outbox]);
    },
    requestHostStart(deliveryId) {
      if (offline) return Promise.resolve(OFFLINE);
      // The control plane may REQUEST a start. It never reports that execution
      // occurred, and it creates no runtime of its own: the honest answer is
      // that the request was delivered, and the host decides.
      return Promise.resolve({
        ok: true,
        message: `host start requested for ${deliveryId}; the host decides whether to start, and no execution is claimed here`,
      });
    },
  };
}

/** Re-exported so a caller can hold "no control plane" and "a simulated one" behind one type. */
export { UNBOUND_COORDINATION_PORT };
