/**
 * The coordination port: the seam an optional hosted control plane binds to,
 * and the refusing implementation this product actually ships.
 *
 * `UNBOUND_COORDINATION_PORT` is the default for the same reason the unbound
 * external-action port is: "the core local delivery has no dependency on
 * connector availability" is a claim that should be mechanical rather than a
 * convention. With nothing bound, every send refuses and every receive yields
 * nothing — and the delivery proceeds, because no local path consults this
 * port for permission to continue.
 */

import type { CoordinationMessage } from "./message.ts";

export interface CoordinationDispatch {
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
}

/**
 * Both directions are request-shaped. `requestHostStart` returns whether the
 * host accepted the REQUEST — never whether execution happened, which the
 * control plane is not in a position to know and this port is therefore not in
 * a position to report.
 */
export interface CoordinationPort {
  send(message: CoordinationMessage): Promise<CoordinationDispatch>;
  receive(): Promise<readonly unknown[]>;
  requestHostStart(deliveryId: string): Promise<CoordinationDispatch>;
}

export const COORDINATION_PORT_UNBOUND_CODE = "coordination_port_unbound";

export const UNBOUND_COORDINATION_PORT: CoordinationPort = {
  send: () =>
    Promise.resolve({
      ok: false,
      code: COORDINATION_PORT_UNBOUND_CODE,
      message: "no control plane is bound; coordination is optional and this installation coordinates with nothing",
    }),
  receive: () => Promise.resolve([]),
  requestHostStart: () =>
    Promise.resolve({
      ok: false,
      code: COORDINATION_PORT_UNBOUND_CODE,
      message:
        "no control plane is bound; a host start request has nowhere to come from, and the local delivery needs none to proceed",
    }),
};
