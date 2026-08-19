import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const CACHE_DIR = join(process.cwd(), '.cache');

/**
 * Fetch a URL, caching the body on disk. The BSData library catalogues run to
 * several megabytes each, so re-downloading them on every pipeline run makes
 * iteration painfully slow. Pass `--fresh` to bypass.
 */
export async function fetchCached(url, { fresh = false } = {}) {
  const key = createHash('sha1').update(url).digest('hex').slice(0, 16);
  const ext = url.endsWith('.yaml') ? 'yaml' : 'json';
  const path = join(CACHE_DIR, `${key}.${ext}`);

  if (!fresh && existsSync(path)) {
    return readFile(path, 'utf8');
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  const body = await res.text();

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, 'utf8');
  return body;
}
