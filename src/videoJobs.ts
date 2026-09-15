import { randomUUID } from 'crypto';
import { config } from './config';
import type { VideoHandle, VideoStatus } from './providers/types';

export interface VideoJob {
  id: string;
  /** Owner. A job is only readable by the uid that started it. */
  uid: string;
  handle: VideoHandle;
  status: VideoStatus;
  /** Upstream location of the finished clip. Never sent to the client: on both
   * providers it is only fetchable with the API key. */
  upstreamUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

const jobs = new Map<string, VideoJob>();

export function createJob(uid: string, handle: VideoHandle): VideoJob {
  const now = Date.now();
  const job: VideoJob = {
    id: randomUUID(),
    uid,
    handle,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  jobs.set(job.id, job);
  return job;
}

/**
 * The job, but only for the uid that started it — an id guessed or leaked from
 * another user's device must not resolve.
 */
export function getJob(id: string, uid: string): VideoJob | null {
  const job = jobs.get(id);
  if (!job || job.uid !== uid) return null;
  return job;
}

export function updateJob(job: VideoJob, patch: Partial<VideoJob>): VideoJob {
  Object.assign(job, patch, { updatedAt: Date.now() });
  return job;
}

/**
 * Drops jobs past their TTL. Renders live on the provider's side, so this only
 * forgets the handle — and both upstreams expire their own output anyway.
 */
export function pruneVideoJobs(now = Date.now()): void {
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > config.videoJobTtlMs) jobs.delete(id);
  }
}
