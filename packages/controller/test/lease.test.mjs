import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LeaseManager } from '../dist/lease.js';

describe('Controller Lease & Fence Management', () => {
  it('allows valid progressive lifecycle transitions', () => {
    const mgr = new LeaseManager();
    const now = Date.now();
    const fence = { job_id: 'job-1', attempt_id: 'att-1', lease_epoch: 1 };

    mgr.registerLease({
      ...fence,
      tenant_id: 'tenant-1',
      worker_id: 'worker-1',
      state: 'preparing',
      lease_expires_at_ms: now + 60000,
      last_heartbeat_at_ms: now,
    });

    // preparing -> rendering
    mgr.transition(fence, 'rendering', now + 1000);
    // rendering -> encoding
    mgr.transition(fence, 'encoding', now + 2000);
    // encoding -> verifying
    mgr.transition(fence, 'verifying', now + 3000);
    // verifying -> succeeded
    mgr.transition(fence, 'succeeded', now + 4000);

    // Job is completed / terminal; lease released
    assert.throws(() => mgr.verifyFence(fence), /No active lease found/);
  });

  it('rejects stale lease_epoch from zombie worker', () => {
    const mgr = new LeaseManager();
    const now = Date.now();

    mgr.registerLease({
      job_id: 'job-2',
      attempt_id: 'att-2',
      lease_epoch: 2,
      tenant_id: 'tenant-1',
      worker_id: 'worker-2',
      state: 'rendering',
      lease_expires_at_ms: now + 60000,
      last_heartbeat_at_ms: now,
    });

    // Stale worker with epoch 1 tries to heart-beat or transition
    const staleFence = { job_id: 'job-2', attempt_id: 'att-2', lease_epoch: 1 };
    assert.throws(() => mgr.verifyFence(staleFence, now), /Fencing token mismatch/);
  });

  it('rejects expired lease', () => {
    const mgr = new LeaseManager();
    const now = Date.now();
    const fence = { job_id: 'job-3', attempt_id: 'att-3', lease_epoch: 1 };

    mgr.registerLease({
      ...fence,
      tenant_id: 'tenant-1',
      worker_id: 'worker-1',
      state: 'rendering',
      lease_expires_at_ms: now + 1000,
      last_heartbeat_at_ms: now,
    });

    // Attempting action after lease expires
    assert.throws(() => mgr.verifyFence(fence, now + 2000), /Lease expired/);
  });

  it('allows cancel_requested transition and terminal canceled', () => {
    const mgr = new LeaseManager();
    const now = Date.now();
    const fence = { job_id: 'job-4', attempt_id: 'att-1', lease_epoch: 1 };

    mgr.registerLease({
      ...fence,
      tenant_id: 'tenant-1',
      worker_id: 'worker-1',
      state: 'rendering',
      lease_expires_at_ms: now + 60000,
      last_heartbeat_at_ms: now,
    });

    mgr.transition(fence, 'cancel_requested', now + 500);
    mgr.transition(fence, 'canceled', now + 1000);

    assert.throws(() => mgr.verifyFence(fence), /No active lease found/);
  });
});
