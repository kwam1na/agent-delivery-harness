/**
 * The authority-revocation truth table. The compiled snapshot is immutable;
 * the separate monotonic revocation epoch is the emergency ceiling:
 *
 *   - a revocation NARROWS immediately — including after `ready`, when the
 *     final candidate commit already stands;
 *   - the store has no grammar through which authority could be granted, so
 *     expansion is unspellable there;
 *   - expansion arrives only as a new owner-approved policy generation, and
 *     even then an accepted delivery's ceiling is the snapshot it was bound
 *     to — a wider current generation never raises it;
 *   - the epoch never rolls back: a lower epoch than the highest observed is
 *     a rejected write to the authority store, not a restoration.
 *
 * Written RED before `authority.ts` existed.
 */
import { describe, expect, it } from "vitest";
import { compileRepositoryPolicy } from "./compile.ts";
import {
  checkActionAuthorization,
  effectiveDeliveryAuthority,
  observeAuthorityEpoch,
  validateAuthorityRevocation,
  type AuthorityRevocation,
} from "./authority.ts";
import {
  compositionPersonaSetFixture,
  mergeAdapterFixture,
  mergeAuthorityDocumentFixture,
  policyDocumentFixture,
  repositoryAdapterSetFixture,
  sensorAdapterFixture,
} from "./fixtures.ts";

const snapshotOf = (document: Record<string, unknown>, adapters = repositoryAdapterSetFixture()) => {
  const result = compileRepositoryPolicy({
    document,
    adapters,
    personas: compositionPersonaSetFixture(),
    productTrustRevocationEpoch: 0,
    repositoryAuthorityRevocationEpoch: 0,
  });
  if (!result.ok) throw new Error(`fixture must compile: ${JSON.stringify(result.rejections)}`);
  return result.compiled.snapshot;
};

const boundWithMerge = () => snapshotOf(mergeAuthorityDocumentFixture(), [sensorAdapterFixture(), mergeAdapterFixture()]);

const revocation = (overrides: Record<string, unknown> = {}): AuthorityRevocation =>
  ({
    spec: "authority-revocation/1",
    epoch: 0,
    revokedAuthority: [],
    revokedFinishLines: [],
    ...overrides,
  }) as unknown as AuthorityRevocation;

const codesOf = (verdict: { readonly ok: boolean }): readonly string[] =>
  verdict.ok
    ? []
    : (verdict as unknown as { rejections: readonly { code: string }[] }).rejections.map((rejection) => rejection.code);

describe("the authority store grammar", () => {
  it("accepts the empty revocation state", () => {
    expect(validateAuthorityRevocation(revocation()).ok).toBe(true);
  });

  it("has no member through which authority could be granted — expansion is unspellable in the store", () => {
    const verdict = validateAuthorityRevocation(revocation({ grantedAuthority: ["deploy"] }));
    expect(codesOf(verdict)).toContain("unknown_member");
  });
});

describe("epoch monotonicity", () => {
  it("advances the floor on a higher epoch and holds it on an equal one", () => {
    const advanced = observeAuthorityEpoch(2, revocation({ epoch: 5 }));
    expect(advanced.ok && advanced.highestObservedEpoch === 5).toBe(true);
    const held = observeAuthorityEpoch(5, revocation({ epoch: 5 }));
    expect(held.ok && held.highestObservedEpoch === 5).toBe(true);
  });

  it("rejects an epoch rollback — a candidate rewriting the store backward restores nothing", () => {
    const verdict = observeAuthorityEpoch(5, revocation({ epoch: 3 }));
    expect(codesOf(verdict)).toContain("epoch_rollback");
  });
});

describe("the authorization truth table", () => {
  const table: readonly {
    readonly name: string;
    readonly action: string;
    readonly bound: () => ReturnType<typeof boundWithMerge>;
    readonly revocation: AuthorityRevocation;
    readonly highestObservedEpoch: number;
    readonly expect: "authorized" | string;
  }[] = [
    {
      name: "granted merge, no revocation: authorized",
      action: "merge",
      bound: boundWithMerge,
      revocation: revocation(),
      highestObservedEpoch: 0,
      expect: "authorized",
    },
    {
      name: "granted merge, revoked after `ready` at a later epoch: blocked",
      action: "merge",
      bound: boundWithMerge,
      revocation: revocation({ epoch: 1, revokedAuthority: ["merge"] }),
      highestObservedEpoch: 0,
      expect: "authority_revoked",
    },
    {
      name: "never-granted deploy: absence of a grant is denial",
      action: "deploy",
      bound: boundWithMerge,
      revocation: revocation(),
      highestObservedEpoch: 0,
      expect: "authority_not_granted",
    },
    {
      name: "granted merge, store rolled back below the observed floor: rejected, not restored",
      action: "merge",
      bound: boundWithMerge,
      revocation: revocation({ epoch: 1 }),
      highestObservedEpoch: 4,
      expect: "epoch_rollback",
    },
  ];

  for (const row of table) {
    it(row.name, () => {
      const verdict = checkActionAuthorization({
        action: row.action,
        bound: row.bound(),
        revocation: row.revocation,
        highestObservedEpoch: row.highestObservedEpoch,
      });
      if (row.expect === "authorized") {
        expect(verdict.ok, JSON.stringify(verdict)).toBe(true);
      } else {
        expect(codesOf(verdict)).toContain(row.expect);
      }
    });
  }
});

describe("expansion never raises an accepted delivery's ceiling", () => {
  it("ignores a wider current generation — the bound snapshot is the ceiling", () => {
    const bound = snapshotOf(policyDocumentFixture());
    const widerCurrent = boundWithMerge();
    const effective = effectiveDeliveryAuthority({ bound, revocation: revocation(), currentGeneration: widerCurrent });
    expect(effective.grantedAuthority).toEqual([]);
    expect(effective.grantedFinishLines).toEqual(["merge-ready"]);
  });

  it("honors a narrower current generation — both layers can only narrow", () => {
    const bound = boundWithMerge();
    const narrowerCurrent = snapshotOf(policyDocumentFixture());
    const effective = effectiveDeliveryAuthority({ bound, revocation: revocation(), currentGeneration: narrowerCurrent });
    expect(effective.grantedAuthority).toEqual([]);
    expect(effective.grantedFinishLines).toEqual(["merge-ready"]);
  });

  it("subtracts revoked finish lines immediately", () => {
    const bound = boundWithMerge();
    const effective = effectiveDeliveryAuthority({
      bound,
      revocation: revocation({ epoch: 1, revokedAuthority: ["merge"], revokedFinishLines: ["merge"] }),
    });
    expect(effective.grantedAuthority).toEqual([]);
    expect(effective.grantedFinishLines).toEqual(["merge-ready"]);
  });
});
