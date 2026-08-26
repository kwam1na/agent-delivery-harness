/**
 * Delivery harness GitHub Action.
 *
 * The package barrel. `action.yml` runs `src/main.ts` directly — a composite
 * action's entry point is a file path, not an import — so this exists for the
 * consumers that reach for the Action's surface as a library: the self-hosting
 * workflow's tests, and anything that wants to drive the verification from a
 * simulated event without a runner.
 */
export const PACKAGE_NAME = "@agent-delivery-harness/action";

export {
  ACTION_EXIT_OK,
  ACTION_EXIT_POLICY,
  ACTION_MODES,
  CI_POLICY_INPUT_ENV,
  defaultRuntime,
  importHarnessConfig,
  main,
  runAction,
  type ActionMode,
  type ActionResult,
  type ActionRuntime,
} from "./main.ts";
