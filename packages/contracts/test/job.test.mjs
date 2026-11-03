import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isTerminalJobState, TERMINAL_JOB_STATES } from '../dist/index.js';

describe('Job State Machine Constants', () => {
  it('correctly classifies terminal states', () => {
    assert.strictEqual(isTerminalJobState('succeeded'), true);
    assert.strictEqual(isTerminalJobState('failed'), true);
    assert.strictEqual(isTerminalJobState('canceled'), true);

    const nonTerminal = [
      'queued',
      'preparing',
      'rendering',
      'encoding',
      'verifying',
      'cancel_requested',
      'retry_wait',
    ];
    for (const state of nonTerminal) {
      assert.strictEqual(isTerminalJobState(state), false, `State ${state} should not be terminal`);
    }
    assert.strictEqual(TERMINAL_JOB_STATES.size, 3);
  });
});
