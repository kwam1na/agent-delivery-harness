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
  type CoordinationMessage,
  type CoordinationMessageKind,
} from "./message.ts";
import { reconcileRemoteClaim, type LocalHistoryView, type ClaimReconciliation } from "./reconcile.ts";
import { UNBOUND_COORDINATION_PORT, type CoordinationDispatch, type CoordinationPort } from "./port.ts";

export interface SimulatedMessageOptions {
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
  /** Mints a well-formed message; every field is overridable so a corpus can bend exactly one. */
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
      messageId: `sim-message-${minted}`,
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
