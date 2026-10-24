import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import { del, get, put } from '@vercel/blob';

/** Where capture zips come from and snapshots go: the Blob store, or a directory in tests. */
export interface Storage {
  download(pathname: string, file: string): Promise<void>;
  upload(pathname: string, file: string, contentType: string): Promise<void>;
  remove(pathnames: string[]): Promise<void>;
}

/** The app's private Blob store. The SDK reads BLOB_READ_WRITE_TOKEN (from `vercel env pull`). */
export const blobStorage: Storage = {
  async download(pathname, file) {
    const result = await get(pathname, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) throw new Error(`${pathname} is not in the Blob store`);
    await pipeline(Readable.fromWeb(result.stream as unknown as NodeReadableStream), createWriteStream(file));
  },
  async upload(pathname, file, contentType) {
    const { size } = await stat(file);
    await put(pathname, createReadStream(file), {
      access: 'private',
      contentType,
      allowOverwrite: true,
      // Vercel recommends parts past 100 MB; a long capture's splat can get there.
      multipart: size > 100 * 1024 ** 2,
    });
  },
  async remove(pathnames) {
    if (pathnames.length) await del(pathnames);
  },
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
