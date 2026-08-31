import assert from 'node:assert/strict';
import test from 'node:test';
import { indexedDB } from 'fake-indexeddb';

import { GoogleTilesetSource } from '../src/sources.mjs';
import { TileCache } from '../src/tile-cache.mjs';

Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: indexedDB
});
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
        storage: {
            estimate: async () => ({ usage: 0, quota: 10 * 1024 * 1024 }),
            persist: async () => true
        }
    }
});

function response(bytes, status = 200, headers = undefined) {
    return new Response(bytes, { status, headers });
}

function openDatabase(name, version, upgrade) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(name, version);
        request.onupgradeneeded = () => upgrade?.(request.result, request.transaction);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
        transaction.onerror = () => {};
    });
}

async function readRecord(db, storeName, key) {
    return new Promise((resolve) => {
        const request = db.transaction(storeName, 'readonly').objectStore(storeName).get(key);
        request.onsuccess = () => resolve(request.result ?? null);
        request.onerror = () => resolve(null);
    });
}

test('Google child cache keys survive session rotation while roots always bypass caching', () => {
    const source = new GoogleTilesetSource('secret');
    const root = source.getRootRequest();
    assert.equal(root.cacheable, false);

    const first = source.resolveRequest(
        'https://tile.googleapis.com/v1/3dtiles/tile.glb?session=first&key=secret'
    );
    source.setSession('second');
    const second = source.resolveRequest(
        'https://tile.googleapis.com/v1/3dtiles/tile.glb?session=first&key=secret'
    );
    assert.notEqual(first.url, second.url);
    assert.equal(first.cacheKey, second.cacheKey);
    assert.equal(first.maxAgeMs, 3 * 60 * 60 * 1000);
    assert.doesNotMatch(first.cacheKey, /session=|key=/);
});

test('root request stays session-less once a session is held so refresh can mint a new token', () => {
    // Regression: a held (possibly expired) session must never be stamped onto
    // the root request. Otherwise refreshSession() poisons its own re-fetch with
    // the dead token, Google returns 400 INVALID_ARGUMENT, and every tile retries
    // forever on the expired session.
    const source = new GoogleTilesetSource('secret');
    source.setSession('expired-token');
    const root = source.getRootRequest();
    assert.doesNotMatch(root.url, /session=/);
    // An opaque rootUrl that itself carries a stale session must be stripped too.
    const opaque = new GoogleTilesetSource(
        null,
        undefined,
        'https://tile.googleapis.com/v1/3dtiles/root.json?key=secret&session=stale'
    );
    opaque.setSession('also-stale');
    assert.doesNotMatch(opaque.getRootRequest().url, /session=/);
});

test('L1 coalesces canonical requests and only aborts the network when every waiter leaves', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    let networkCalls = 0;
    let networkSignal = null;
    let resolveNetwork;
    globalThis.fetch = (_url, init) => {
        networkCalls++;
        networkSignal = init.signal;
        return new Promise((resolve, reject) => {
            resolveNetwork = () => resolve(response(new Uint8Array([1, 2, 3])));
            init.signal.addEventListener('abort', () => {
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
            }, { once: true });
        });
    };

    const cache = new TileCache({ persistent: false });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = cache.fetchBuffer('https://example.test/a?session=1', {
        signal: firstController.signal
    }, { key: 'https://example.test/a' });
    const second = cache.fetchBuffer('https://example.test/a?session=2', {
        signal: secondController.signal
    }, { key: 'https://example.test/a' });

    firstController.abort();
    await assert.rejects(first, error => error.name === 'AbortError');
    assert.equal(networkSignal.aborted, false, 'another canonical-key waiter still needs the bytes');
    resolveNetwork();
    assert.deepEqual([...new Uint8Array(await second)], [1, 2, 3]);
    assert.equal(networkCalls, 1);
    const stats = cache.snapshot();
    assert.equal(stats.l1Hits, 1);
    assert.equal(stats.networkFetches, 1);
    assert.equal(stats.hitRate, 0.5);
});

test('persistent child bytes are reused by a new cache instance', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    let networkCalls = 0;
    globalThis.fetch = async () => {
        networkCalls++;
        return response(new Uint8Array([4, 5, 6, 7]));
    };
    const dbName = `terratile-reload-${Date.now()}-${Math.random()}`;
    const options = { dbName, maxMemoryBytes: 0, persistent: true };
    const first = new TileCache(options);
    const key = 'https://tile.googleapis.com/v1/3dtiles/tile.glb';
    await first.fetchBuffer(`${key}?session=one`, {}, { key });

    // Writes are intentionally off the render-critical path. Poll until the
    // first cache reports its committed persistent bytes.
    for (let attempt = 0; attempt < 20; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        if ((await first.getStats()).persistentBytes > 0) break;
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 1));
    }

    const reloaded = new TileCache(options);
    const bytes = await reloaded.fetchBuffer(`${key}?session=two`, {}, { key });
    assert.deepEqual([...new Uint8Array(bytes)], [4, 5, 6, 7]);
    assert.equal(networkCalls, 1, 'reload reads the canonical child key from IndexedDB');
    assert.equal(reloaded.snapshot().l2Hits, 1);
    assert.equal(reloaded.snapshot().missRate, 0);
});

test('stale Google cache rows are refetched with the current session instead of poisoning a later visit', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    const dbName = `terratile-stale-${Date.now()}-${Math.random()}`;
    const key = 'https://tile.googleapis.com/v1/3dtiles/old.json';
    const db = await openDatabase(dbName, 2, (database) => {
        const tiles = database.createObjectStore('tiles', { keyPath: 'url' });
        tiles.createIndex('ts', 'ts');
        const metadata = database.createObjectStore('tiles-meta', { keyPath: 'url' });
        metadata.createIndex('ts', 'ts');
    });
    const oldTimestamp = Date.now() - (4 * 60 * 60 * 1000);
    const write = db.transaction(['tiles', 'tiles-meta'], 'readwrite');
    write.objectStore('tiles').put({
        url: key,
        bytes: new Uint8Array([1]).buffer,
        size: 1,
        ts: oldTimestamp
    });
    write.objectStore('tiles-meta').put({ url: key, size: 1, ts: oldTimestamp });
    await transactionDone(write);
    db.close();

    let requestedUrl = null;
    globalThis.fetch = async (url) => {
        requestedUrl = url;
        return response(new Uint8Array([9, 9]), 200, { 'Cache-Control': 'max-age=7200' });
    };
    const source = new GoogleTilesetSource('secret');
    source.setSession('fresh-session');
    const descriptor = source.resolveRequest(`${key}?session=expired&key=secret`);
    const cache = new TileCache({ dbName, maxMemoryBytes: 0, persistent: true });
    const bytes = await cache.fetchBuffer(descriptor.url, {}, {
        key: descriptor.cacheKey,
        maxAgeMs: descriptor.maxAgeMs
    });

    assert.deepEqual([...new Uint8Array(bytes)], [9, 9]);
    assert.match(requestedUrl, /session=fresh-session/);
    assert.equal(cache.snapshot().staleEntries, 1);
    assert.equal(cache.snapshot().networkFetches, 1);
});

test('server no-store prevents a tile response from entering persistent or memory cache', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return response(new Uint8Array([calls]), 200, { 'Cache-Control': 'no-store' });
    };
    const cache = new TileCache({
        dbName: `terratile-no-store-${Date.now()}-${Math.random()}`,
        persistent: true
    });
    const first = await cache.fetchBuffer('https://example.test/private.glb');
    const second = await cache.fetchBuffer('https://example.test/private.glb');
    assert.deepEqual([...new Uint8Array(first)], [1]);
    assert.deepEqual([...new Uint8Array(second)], [2]);
    assert.equal(calls, 2);
    assert.equal(cache.snapshot().memoryEntries, 0);
});

test('must-revalidate keeps a response fresh until max-age expires', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return response(new Uint8Array([7]), 200, {
            'Cache-Control': 'private, max-age=14400, must-revalidate'
        });
    };
    const cache = new TileCache({ persistent: false });
    await cache.fetchBuffer('https://example.test/fresh.glb', {}, { maxAgeMs: 3 * 60 * 60 * 1000 });
    await cache.fetchBuffer('https://example.test/fresh.glb', {}, { maxAgeMs: 3 * 60 * 60 * 1000 });
    assert.equal(calls, 1);
    assert.equal(cache.snapshot().l1Hits, 1);
});

test('schema v1 upgrades to separate v2 LRU metadata without rewriting tile bytes', async () => {
    const dbName = `terratile-migration-${Date.now()}-${Math.random()}`;
    const key = 'https://example.test/legacy.glb';
    const originalTimestamp = 1234;
    const legacy = await openDatabase(dbName, 1, (db) => {
        const store = db.createObjectStore('tiles', { keyPath: 'url' });
        store.createIndex('ts', 'ts');
    });
    const write = legacy.transaction('tiles', 'readwrite');
    write.objectStore('tiles').put({
        url: key,
        bytes: new Uint8Array([9, 8, 7]).buffer,
        size: 3,
        ts: originalTimestamp
    });
    await transactionDone(write);
    legacy.close();

    const cache = new TileCache({ dbName, maxMemoryBytes: 0, persistent: true });
    const bytes = await cache.fetchBuffer(key);
    assert.deepEqual([...new Uint8Array(bytes)], [9, 8, 7]);
    assert.equal(cache.snapshot().l2Hits, 1);
    assert.equal(cache.snapshot().schemaVersion, 2);

    const upgraded = await openDatabase(dbName, 2);
    assert.equal(upgraded.objectStoreNames.contains('tiles-meta'), true);
    const tile = await readRecord(upgraded, 'tiles', key);
    const metadata = await readRecord(upgraded, 'tiles-meta', key);
    assert.equal(tile.ts, originalTimestamp, 'an LRU hit did not rewrite the large tile row');
    assert.ok(metadata.ts > originalTimestamp);
    assert.equal(metadata.size, 3);
    upgraded.close();
});

test('uncached root policy performs a fresh request every time', async (t) => {
    const originalFetch = globalThis.fetch;
    t.after(() => {
        globalThis.fetch = originalFetch;
    });
    let calls = 0;
    globalThis.fetch = async () => {
        calls++;
        return response(new Uint8Array([calls]));
    };
    const cache = new TileCache({ persistent: false });
    const source = new GoogleTilesetSource('secret');
    const root = source.getRootRequest();
    await cache.fetchBuffer(root.url, root.requestInit, root);
    await cache.fetchBuffer(root.url, root.requestInit, root);
    assert.equal(calls, 2);
    assert.equal(cache.snapshot().bypasses, 2);
});

test('persistent write failures are reported without breaking tile delivery', async (t) => {
    const originalFetch = globalThis.fetch;
    const originalIndexedDb = globalThis.indexedDB;
    t.after(() => {
        globalThis.fetch = originalFetch;
        Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: originalIndexedDb });
    });
    Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined });
    globalThis.fetch = async () => response(new Uint8Array([3, 2, 1]));
    const cache = new TileCache({ dbName: `unavailable-${Date.now()}`, persistent: true });
    const bytes = await cache.fetchBuffer('https://example.test/no-idb.glb');
    assert.deepEqual([...new Uint8Array(bytes)], [3, 2, 1]);
    for (let attempt = 0; attempt < 20 && cache.snapshot().failedWrites === 0; attempt++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.equal(cache.snapshot().failedWrites, 1);
    assert.ok(cache.snapshot().lastWriteError);
});

test('tile cache defaults to page-session memory only', () => {
    assert.equal(new TileCache().snapshot().persistent, false);
});
