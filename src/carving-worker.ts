/**
 * The carving worker: tracing a picture for the pumpkin carving import off the game's main thread,
 * so dragging a slider in the preview never holds a frame of the game. Built on its own and started
 * from a blob url by features/pumpkin-import.ts, which traces on the page instead if a page refuses
 * workers.
 */
import { pictureMask, traceCarving, type PictureBackground, type PictureSettings, type TraceResult } from './carving-trace.js';

export interface CarvingJob {
  id: number;
  /** Names the drawn picture, so the worker can keep it and be sent only the settings next time. */
  pictureKey: string;
  data: Uint8ClampedArray;
  background: PictureBackground;
  settings: PictureSettings;
  smoothing: number;
  /** Mask cells per grid unit `data` is drawn at (see CarvingMask). */
  scale: number;
}
/** A reply carries the trace, or an error when tracing threw, so the page can trace it itself. */
export interface CarvingReply { id: number; result?: TraceResult; error?: string }

export function runCarvingJob(job: CarvingJob): TraceResult {
  return traceCarving(pictureMask(job.data, job.background, job.settings, job.scale), { smoothing: job.smoothing, scale: job.scale });
}

/** What the page posts: a job, with the picture left out when the worker already holds it. */
export type CarvingMessage = Omit<CarvingJob, 'data'> & { data?: Uint8ClampedArray };

const scope = globalThis as unknown as { postMessage(message: unknown): void; onmessage: ((event: MessageEvent) => void) | null; document?: unknown };
if (typeof scope.document === 'undefined' && typeof scope.postMessage === 'function') {
  // The last picture sent. A drag or a slider sends the same one over and over, and at 768 x 768 it
  // is 2.4 MB to copy each time.
  let held: { key: string; data: Uint8ClampedArray } | null = null;
  scope.onmessage = event => {
    const message = event.data as CarvingMessage;
    try {
      if (message.data) held = { key: message.pictureKey, data: message.data };
      if (held?.key !== message.pictureKey) throw new Error('The picture for this job was not sent.');
      scope.postMessage({ id: message.id, result: runCarvingJob({ ...message, data: held.data }) } satisfies CarvingReply);
    } catch (error) {
      scope.postMessage({ id: message.id, error: String(error) } satisfies CarvingReply);
    }
  };
  scope.postMessage({ type: 'ready' });
}
