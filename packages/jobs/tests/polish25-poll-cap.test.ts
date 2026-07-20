/**
 * Polish-25 Commit 6 regression pin.
 *
 * Job 3634604b evidence: MakeUGC video cmrt9t0yo000713fkiqltdp2k
 * was still at ~50% completion 15+ min in. The Commit-2 cap of 60
 * polls × 10s = 10 min turned otherwise-successful renders into
 * false timeout-fails. Commit 6 raises the cap to 180 attempts
 * (~30 min) so routine queue-depth latency no longer kills jobs
 * mid-render.
 *
 * A single-line constant pin — a numeric change here is a
 * DELIBERATE operational tuning decision (queue-behavior
 * observation from real runs), not an accidental edit.
 */
import { describe, expect, it } from 'vitest';
import { MAKEUGC_POLL_MAX_ATTEMPTS } from '../src/functions/generate-polish25-makeugc';

describe('Polish-25 Commit 6: MakeUGC poll cap raised to 180 attempts (~30 min)', () => {
  it('MAKEUGC_POLL_MAX_ATTEMPTS = 180', () => {
    expect(MAKEUGC_POLL_MAX_ATTEMPTS).toBe(180);
  });

  it('cap is at least 3× the Commit-2 value (60) — pins the operational tuning', () => {
    expect(MAKEUGC_POLL_MAX_ATTEMPTS).toBeGreaterThanOrEqual(180);
  });
});
