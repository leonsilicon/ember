/**
 * Client for server/depth-worker (a Swift program running Depth Anything V2 through Core ML).
 * It decodes the phone's JPEGs too, since Bun has no image decoder. See the protocol at the
 * top of server/depth-worker/Sources/depth_worker/main.swift.
 */

export type DepthResult = {
  width: number;
  height: number;
  /** width×height RGB, top row first. */
  rgb: Uint8Array;
  /** Relative inverse depth (larger is nearer, unknown scale and shift), or null if not asked for. */
  disparity: Float32Array | null;
};

/** What the live pipeline needs from a depth model; tests substitute a fake. */
export interface DepthEstimator {
  /** False once it can't take more work (the worker exited); a new one should be started. */
  readonly alive: boolean;
  estimate(jpeg: Uint8Array, width: number, height: number, wantDepth: boolean): Promise<DepthResult>;
  close(): void;
}

type Pending = { resolve: (result: DepthResult) => void; reject: (error: Error) => void };

const RESPONSE_HEADER = 24;

export class DepthWorker implements DepthEstimator {
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private buffered = new Uint8Array(0);
  private failure: Error | null = null;
  private ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;

  private constructor(private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'>) {
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.read();
    proc.exited.then(async (code) => {
      const stderr = (await new Response(proc.stderr).text().catch(() => '')).trim();
      this.fail(new Error(`depth worker exited with code ${code}${stderr ? `: ${stderr.split('\n').slice(-3).join(' ')}` : ''}`));
    });
  }

  /** Starts the worker and resolves once its model is loaded (the first load takes a few seconds). */
  static async start(bin: string, model: string) {
    const worker = new DepthWorker(Bun.spawn([bin, model], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }));
    await worker.ready;
    return worker;
  }

  get alive() {
    return this.failure === null;
  }

  estimate(jpeg: Uint8Array, width: number, height: number, wantDepth: boolean) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    const header = new Uint32Array([id, width, height, wantDepth ? 1 : 0, jpeg.byteLength]);
    const result = new Promise<DepthResult>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.proc.stdin.write(new Uint8Array(header.buffer));
    this.proc.stdin.write(jpeg);
    this.proc.stdin.flush();
    return result;
  }

  close() {
    this.fail(new Error('depth worker closed'));
    this.proc.kill();
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.rejectReady(error);
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private async read() {
    try {
      for await (const chunk of this.proc.stdout) {
        const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
        joined.set(this.buffered);
        joined.set(chunk, this.buffered.byteLength);
        this.buffered = joined;
        this.drain();
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Handles every complete response in the buffer. */
  private drain() {
    while (this.buffered.byteLength >= RESPONSE_HEADER) {
      const view = new DataView(this.buffered.buffer, this.buffered.byteOffset, this.buffered.byteLength);
      const [id, status, width, height, flags, messageLength] = [0, 1, 2, 3, 4, 5].map((i) => view.getUint32(i * 4, true));
      const pixels = width * height;
      const total = RESPONSE_HEADER + messageLength + pixels * 3 + (flags & 1 ? pixels * 4 : 0);
      if (this.buffered.byteLength < total) return;
      const bytes = this.buffered.slice(0, total);
      this.buffered = this.buffered.slice(total);

      const message = new TextDecoder().decode(bytes.subarray(RESPONSE_HEADER, RESPONSE_HEADER + messageLength));
      if (id === 0) {
        if (status === 0) this.resolveReady();
        else this.fail(new Error(message));
        continue;
      }
      const pending = this.pending.get(id);
      this.pending.delete(id);
      if (!pending) continue;
      if (status !== 0) {
        pending.reject(new Error(message));
        continue;
      }
      const rgbStart = RESPONSE_HEADER + messageLength;
      const depthStart = rgbStart + pixels * 3;
      pending.resolve({
        width,
        height,
        rgb: bytes.subarray(rgbStart, depthStart),
        // Copied out so the floats start 4-byte aligned.
        disparity: flags & 1 ? new Float32Array(bytes.slice(depthStart, depthStart + pixels * 4).buffer) : null,
      });
    }
  }
}
