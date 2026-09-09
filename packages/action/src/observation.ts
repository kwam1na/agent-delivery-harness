/** Runtime boundary only: expiry applies to owner exemptions, never evidence age. */
export function observeHostedCheckTime(): string {
  return `${new Date().toISOString().slice(0, 19)}Z`;
}
