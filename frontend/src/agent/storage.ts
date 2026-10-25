import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { setTimeout as sleep } from 'node:timers/promises';

import { BlobServiceNotAvailable, BlobServiceRateLimited, del, get, put } from '@vercel/blob';

/** Where capture zips come from and snapshots go: the Blob store, or a directory in tests. */
export interface Storage {
  download(pathname: string, file: string): Promise<void>;
  upload(pathname: string, file: string, contentType: string): Promise<void>;
  remove(pathnames: string[]): Promise<void>;
}

const NETWORK = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|EHOSTUNREACH|ENETDOWN|ENETUNREACH|socket|network|fetch failed|timed out/i;

/** Whether an error is worth another try: the network dropped the call, or Blob is briefly unavailable. */
export function transient(error: unknown) {
  if (error instanceof BlobServiceNotAvailable || error instanceof BlobServiceRateLimited) return true;
  if (!(error instanceof Error)) return false;
  const { code } = error as { code?: unknown };
  return NETWORK.test(`${error.name} ${error.message} ${typeof code === 'string' ? code : ''}`);
}

/**
 * Runs `call`, and again after a transient failure, waiting 1 s, 2 s, 4 s… between tries (about a
 * minute in all by default). The Mac moves between the phone's hotspot and Wi-Fi during a demo,
 * which resets whatever socket was open; every call here is idempotent, so one reset shouldn't
 * cost a job minutes of training.
 */
export async function withRetries<T>(what: string, call: () => Promise<T>, { tries = 7, firstWaitMs = 1000 } = {}): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= tries || !transient(error)) throw error;
      const wait = firstWaitMs * 2 ** (attempt - 1);
      console.warn(`${what} failed (${error instanceof Error ? error.message : String(error)}); trying again in ${wait / 1000} s`);
      await sleep(wait);
    }
  }
}

/** The app's private Blob store. The SDK reads BLOB_READ_WRITE_TOKEN (from `vercel env pull`). */
export const blobStorage: Storage = {
  download: (pathname, file) =>
    withRetries(`downloading ${pathname}`, async () => {
      const result = await get(pathname, { access: 'private', useCache: false });
      if (!result || result.statusCode !== 200) throw new Error(`${pathname} is not in the Blob store`);
      // A download cut off halfway is written over by the next try.
      await pipeline(Readable.fromWeb(result.stream as unknown as NodeReadableStream), createWriteStream(file));
    }),
  upload: (pathname, file, contentType) =>
    withRetries(`uploading ${pathname}`, async () => {
      const { size } = await stat(file);
      await put(pathname, createReadStream(file), {
        access: 'private',
        contentType,
        allowOverwrite: true,
        // Vercel recommends parts past 100 MB; a long capture's splat can get there.
        multipart: size > 100 * 1024 ** 2,
      });
    }),
  remove: (pathnames) =>
    withRetries(`removing ${pathnames.join(', ')}`, async () => {
      if (pathnames.length) await del(pathnames);
    }),
};

/** Files under a directory, standing in for the Blob store in tests. */
export function directoryStorage(root: string): Storage {
  return {
    async download(pathname, file) {
      await copyFile(path.join(root, pathname), file);
    },
    async upload(pathname, file) {
      await mkdir(path.dirname(path.join(root, pathname)), { recursive: true });
      await copyFile(file, path.join(root, pathname));
    },
    async remove(pathnames) {
      for (const pathname of pathnames) await rm(path.join(root, pathname), { force: true });
    },
  };
}
