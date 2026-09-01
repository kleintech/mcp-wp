import { describe, it, expect, vi, beforeAll } from 'vitest';
import * as fs from 'fs-extra';
import * as path from 'path';
import * as os from 'os';

// Each site answers /wp/v2/types with its own post types. The same custom type
// slug deliberately carries a different rest_base on each site — that is the
// collision that made the unkeyed cache dangerous rather than merely stale.
const SITE_TYPES: Record<string, any> = {
  siteA: {
    post: { rest_base: 'posts' },
    recipe: { rest_base: 'wprm-recipes' },
    feast_layout: { rest_base: 'feast-layouts' },
  },
  siteB: {
    post: { rest_base: 'posts' },
    recipe: { rest_base: 'site-b-recipes' },
    mih_guide: { rest_base: 'mih-guides' },
  },
};

const requestLog: Array<{ endpoint: string; siteId?: string }> = [];

vi.mock('../../src/wordpress.js', () => ({
  makeWordPressRequest: vi.fn(async (_method: string, endpoint: string, _data?: any, options?: { siteId?: string }) => {
    requestLog.push({ endpoint, siteId: options?.siteId });
    if (endpoint === 'types') {
      return SITE_TYPES[options?.siteId || '__default__'] ?? {};
    }
    return {};
  }),
  logToFile: vi.fn(),
}));

// CACHE_DIR is resolved at module load time from UNIFIED_CONTENT_CACHE_DIR, so
// the env var must be set before the module under test is imported — hence the
// dynamic import below instead of a top-level one.
let getContentEndpoint: (contentType: string, siteId?: string) => Promise<string>;
let cacheDir: string;

beforeAll(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-wp-cache-test-'));
  process.env.UNIFIED_CONTENT_CACHE_DIR = cacheDir;
  ({ getContentEndpoint } = await import('../../src/tools/unified-content.js'));
});

describe('post types cache is keyed per site', () => {
  // The bug this catches: postTypesCache was a single module-level value with
  // no site key, checked BEFORE the correctly-keyed disk cache. After any call
  // for site A, a call for site B within CACHE_DURATION returned A's post
  // types — so discover_content_types listed the wrong site's types, and
  // getContentEndpoint resolved custom-type rest_bases from the wrong site
  // for every read AND write path that goes through it.
  it('does not serve one site\'s post types to another site', async () => {
    const a = await getContentEndpoint('recipe', 'siteA');
    expect(a).toBe('wprm-recipes');

    // On the unkeyed cache this returned 'wprm-recipes' from siteA's entry
    // without ever asking siteB.
    const b = await getContentEndpoint('recipe', 'siteB');
    expect(b).toBe('site-b-recipes');

    const typesCalls = requestLog.filter((r) => r.endpoint === 'types');
    expect(typesCalls.map((r) => r.siteId)).toEqual(['siteA', 'siteB']);
  });

  it('still serves repeat lookups for the same site from cache', async () => {
    const before = requestLog.filter((r) => r.endpoint === 'types').length;

    // feast_layout exists only on siteA; a cache hit must resolve it without
    // another network fetch.
    const a = await getContentEndpoint('feast_layout', 'siteA');
    expect(a).toBe('feast-layouts');

    const after = requestLog.filter((r) => r.endpoint === 'types').length;
    expect(after).toBe(before);
  });

  it('falls through per site: a type unknown to that site is not resolved from another site\'s map', async () => {
    // mih_guide exists only on siteB. With the unkeyed cache holding siteA's
    // map, this returned the raw slug via the "use as-is" fallback — or worse,
    // a collision resolved to siteA's rest_base. Per-site it must resolve from
    // siteB's own map.
    const b = await getContentEndpoint('mih_guide', 'siteB');
    expect(b).toBe('mih-guides');
  });

  it('writes disk cache files under distinct per-site names', async () => {
    // The disk cache was already keyed correctly; this pins that the fix did
    // not regress it while rewiring the memory layer that shadowed it.
    const files = (await fs.readdir(cacheDir)).sort();
    expect(files).toContain('content-types-siteA.json');
    expect(files).toContain('content-types-siteB.json');
  });
});
