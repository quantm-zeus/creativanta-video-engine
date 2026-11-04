/**
 * Job Reconciliation Manager for Creativanta (Task P5-03).
 *
 * Blends real-time webhook callback processing with polling reconciliation:
 *   - Tracks in-flight jobs by jobId and externalReference
 *   - Monotonic state_version guard: higher state_version always takes precedence
 *   - Detects when webhooks are missing or out-of-order and polls for authoritative status
 *   - Zero shared DB assumptions
 */

import { EventEmitter } from 'node:events';
import type { CreativantaClient } from './creativanta-client.js';
import type { CreativantaWebhookReceiver } from './webhook-receiver.js';
import type { JobEventData, JobResponse, WebhookEventPayload } from './types.js';

export interface TrackedJobState {
  jobId: string;
  externalReference?: string;
  state: string;
  stateVersion: number;
  lastUpdatedAt: Date;
  isTerminal: boolean;
  artifacts?: Array<{ id: string; kind: string; mime_type: string }>;
  error?: unknown;
}

export class JobReconciliationManager extends EventEmitter {
  private readonly client: CreativantaClient;
  private readonly receiver?: CreativantaWebhookReceiver;
  private readonly trackedJobs = new Map<string, TrackedJobState>();
  private readonly externalRefToJobId = new Map<string, string>();

  constructor(options: {
    client: CreativantaClient;
    receiver?: CreativantaWebhookReceiver;
  }) {
    super();
    this.client = options.client;
    this.receiver = options.receiver;

    if (this.receiver) {
      this.bindReceiver(this.receiver);
    }
  }

  /**
   * Registers a job to be tracked and reconciled.
   */
  public trackJob(jobId: string, options?: { externalReference?: string; initialState?: string; stateVersion?: number }): TrackedJobState {
    const existing = this.trackedJobs.get(jobId);
    if (existing) {
      if (options?.externalReference && !existing.externalReference) {
        existing.externalReference = options.externalReference;
        this.externalRefToJobId.set(options.externalReference, jobId);
      }
      return existing;
    }

    const tracked: TrackedJobState = {
      jobId,
      externalReference: options?.externalReference,
      state: options?.initialState ?? 'queued',
      stateVersion: options?.stateVersion ?? 1,
      lastUpdatedAt: new Date(),
      isTerminal: ['succeeded', 'failed', 'canceled'].includes(options?.initialState ?? ''),
    };

    this.trackedJobs.set(jobId, tracked);
    if (options?.externalReference) {
      this.externalRefToJobId.set(options.externalReference, jobId);
    }

    return tracked;
  }

  /**
   * Looks up a tracked job by either jobId or externalReference.
   */
  public getTrackedJob(jobIdOrExternalRef: string): TrackedJobState | undefined {
    if (this.trackedJobs.has(jobIdOrExternalRef)) {
      return this.trackedJobs.get(jobIdOrExternalRef);
    }
    const mappedJobId = this.externalRefToJobId.get(jobIdOrExternalRef);
    if (mappedJobId) {
      return this.trackedJobs.get(mappedJobId);
    }
    return undefined;
  }

  /**
   * Reconciles a single job against the video engine API.
   */
  public async reconcileJob(jobIdOrExternalRef: string): Promise<TrackedJobState> {
    let jobId = jobIdOrExternalRef;
    if (this.externalRefToJobId.has(jobIdOrExternalRef)) {
      jobId = this.externalRefToJobId.get(jobIdOrExternalRef)!;
    }

    const latest = await this.client.getJob(jobId);
    return this.updateFromJobResponse(latest);
  }

  /**
   * Reconciles all non-terminal jobs currently tracked.
   */
  public async reconcileAllPending(): Promise<TrackedJobState[]> {
    const results: TrackedJobState[] = [];
    for (const job of this.trackedJobs.values()) {
      if (!job.isTerminal) {
        const updated = await this.reconcileJob(job.jobId);
        results.push(updated);
      }
    }
    return results;
  }

  /**
   * Updates state from a full JobResponse (from polling or GET).
   */
  public updateFromJobResponse(job: JobResponse): TrackedJobState {
    const existing = this.trackJob(job.id, {
      externalReference: job.client_reference,
      initialState: job.state,
      stateVersion: job.state_version,
    });

    if (job.state_version >= existing.stateVersion) {
      const stateChanged = existing.state !== job.state;
      existing.state = job.state;
      existing.stateVersion = job.state_version;
      existing.lastUpdatedAt = new Date();
      existing.isTerminal = ['succeeded', 'failed', 'canceled'].includes(job.state);
      existing.artifacts = job.artifacts;
      existing.error = job.error;

      if (stateChanged) {
        this.emit('state_changed', existing);
        if (existing.isTerminal) {
          this.emit('terminal', existing);
        }
      }
    }

    return existing;
  }

  /**
   * Binds webhook receiver events to the manager.
   */
  private bindReceiver(receiver: CreativantaWebhookReceiver): void {
    receiver.on('event', (payload: WebhookEventPayload<JobEventData>) => {
      const jobId = payload.data?.job_id;
      const state = payload.data?.state;
      const stateVersion = payload.data?.state_version;
      const clientRef = payload.data?.client_reference;

      if (!jobId || !state || typeof stateVersion !== 'number') return;

      const existing = this.trackJob(jobId, {
        externalReference: clientRef,
        initialState: state,
        stateVersion,
      });

      // Monotonic guard: discard out-of-order webhook delivery
      if (stateVersion >= existing.stateVersion) {
        const stateChanged = existing.state !== state;
        existing.state = state;
        existing.stateVersion = stateVersion;
        existing.lastUpdatedAt = new Date();
        existing.isTerminal = ['succeeded', 'failed', 'canceled'].includes(state);

        if (stateChanged) {
          this.emit('state_changed', existing);
          if (existing.isTerminal) {
            this.emit('terminal', existing);
          }
        }
      }
    });
  }
}
