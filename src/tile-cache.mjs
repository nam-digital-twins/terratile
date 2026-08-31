// Reusable two-level byte cache owned by Terratile.
//
// L1 is a bounded in-memory LRU and in-flight request coalescer. L2 is a
// persistent IndexedDB store. Access metadata lives in a separate small object
// store so an LRU touch never rewrites a multi-megabyte tile ArrayBuffer.

const DEFAULT_DB_NAME = 'terratile-cache';
const DEFAULT_STORE = 'tiles';
const DB_VERSION = 2;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 64 * 1024 * 1024;

function abortError() {
    if (typeof DOMException !== 'undefined') return new DOMException('Aborted', 'AbortError');
    const error = new Error('Aborted');
    error.name = 'AbortError';
    return error;
}

async function buildHttpError(response, url) {
    let body = '';
    try {
        body = (await response.clone().text()).slice(0, 400);
    } catch { /* response bodies are best effort */ }
    const error = new Error(body ?
        `tile-cache: HTTP ${response.status} for ${url} -- ${body}` :
        `tile-cache: HTTP ${response.status} for ${url}`);
    error.status = response.status;
    error.body = body;
    return error;
}

function cloneFetchInit(init, signal) {
    if (!init && !signal) return undefined;
    return {
        ...(init ?? {}),
        signal
    };
}

function createCounters() {
    return {
        l1Hits: 0,
        l2Hits: 0,
        misses: 0,
        bypasses: 0,
        networkFetches: 0,
        evictions: 0,
        failedWrites: 0,
        staleEntries: 0,
        revalidations: 0,
        revalidationHits: 0,
        abortedNetworkFetches: 0,
        bytesFromL1: 0,
        bytesFromL2: 0,
        bytesFromNetwork: 0
    };
}

/**
 * Persistent and memory byte cache for tile JSON and binary content.
 *
 * A source can supply canonical keys per request. Google child requests use a
 * sessionless/keyless key while root requests set `cacheable: false`, allowing
 * reloads to reuse tile bytes without pinning an expired root session.
 */
class TileCache {
    constructor({
        dbName = DEFAULT_DB_NAME,
        storeName = DEFAULT_STORE,
        maxBytes = DEFAULT_MAX_BYTES,
        maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES,
        // Keep cache reuse within the current page session by default.
        // IndexedDB remains an explicit opt-in for consumers whose resources
        // are guaranteed stable across provider and application sessions.
        persistent = false,
        copyOnRead = true,
        keyResolver = null,
        skipPredicate = null,
        onEvent = null
    } = {}) {
        this._dbName = dbName;
        this._storeName = storeName;
        this._metaStoreName = `${storeName}-meta`;
        this._maxBytes = Math.max(0, maxBytes);
        this._maxMemoryBytes = Math.max(0, maxMemoryBytes);
        this._persistent = persistent;
        this._copyOnRead = copyOnRead;
        this._keyResolver = keyResolver;
        this._skipPredicate = skipPredicate;
        this._onEvent = onEvent;
        this._memory = new Map();
        this._memoryBytes = 0;
        this._dbPromise = null;
        this._totalBytes = null;
        this._totalBytesInit = null;
        this._quotaBytes = null;
        this._persistentGranted = null;
        this._lastWriteError = null;
        this._evicting = false;
        this._counters = createCounters();
    }

    setEventListener(listener) {
        this._onEvent = listener;
    }

    async fetch(url, init, cacheOptions) {
        const buffer = await this.fetchBuffer(url, init, cacheOptions);
        return new Response(buffer);
    }

    async fetchBuffer(url, init, cacheOptions = {}) {
        const policy = this._resolvePolicy(url, cacheOptions);
        if (!policy.cacheable) {
            this._note('bypasses');
            this._note('networkFetches');
            const response = await globalThis.fetch(url, init);
            if (!response.ok) throw await buildHttpError(response, url);
            const buffer = await response.arrayBuffer();
            this._note('bytesFromNetwork', buffer.byteLength);
            return buffer;
        }

        let entry = this._memory.get(policy.key);
        if (entry?.settled && this._isExpired(entry.expiresAt)) {
            this._memory.delete(policy.key);
            this._memoryBytes = Math.max(0, this._memoryBytes - entry.size);
            this._note('staleEntries');
            entry = null;
        }
        if (entry) {
            this._note('l1Hits');
            if (entry.settled) this._note('bytesFromL1', entry.size);
            this._touchMemory(policy.key, entry);
        } else {
            entry = this._createEntry(policy, url, init);
            this._memory.set(policy.key, entry);
        }
        return this._consume(entry, init?.signal);
    }

    _resolvePolicy(url, cacheOptions) {
        const explicitCacheable = cacheOptions.cacheable;
        const cacheable = explicitCacheable ?? !(this._skipPredicate?.(url) ?? false);
        let key = cacheOptions.key;
        if (!key && this._keyResolver) key = this._keyResolver(url, cacheOptions);
        const configuredMaxAge = Number(cacheOptions.maxAgeMs);
        const maxAgeMs = Number.isFinite(configuredMaxAge) ? Math.max(0, configuredMaxAge) : null;
        return { cacheable, key: key || url, maxAgeMs };
    }

    _createEntry(policy, url, init) {
        const key = policy.key;
        const controller = new AbortController();
        const entry = {
            key,
            controller,
            waiters: 0,
            settled: false,
            size: 0,
            expiresAt: null,
            promise: null
        };
        entry.promise = this._readOrFetch(policy, url, init, controller.signal);
        entry.promise.then((result) => {
            entry.settled = true;
            entry.size = result.buffer.byteLength;
            entry.expiresAt = result.expiresAt;
            if (this._memory.get(key) === entry) {
                if (result.cacheable) {
                    this._memoryBytes += entry.size;
                    this._evictMemory();
                } else {
                    this._memory.delete(key);
                }
            }
        }, (error) => {
            entry.settled = true;
            if (error?.name === 'AbortError') this._note('abortedNetworkFetches');
            if (this._memory.get(key) === entry) this._memory.delete(key);
        });
        return entry;
    }

    _consume(entry, signal) {
        entry.waiters++;
        return new Promise((resolve, reject) => {
            let finished = false;
            const onAbort = () => {
                if (finished) return;
                finished = true;
                entry.waiters = Math.max(0, entry.waiters - 1);
                if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
                signal?.removeEventListener('abort', onAbort);
                reject(abortError());
            };
            const release = () => {
                if (finished) return false;
                finished = true;
                entry.waiters = Math.max(0, entry.waiters - 1);
                if (entry.waiters === 0 && !entry.settled) entry.controller.abort();
                signal?.removeEventListener('abort', onAbort);
                return true;
            };
            if (signal?.aborted) {
                onAbort();
                return;
            }
            signal?.addEventListener('abort', onAbort, { once: true });
            entry.promise.then((result) => {
                const buffer = result.buffer;
                if (release()) resolve(this._copyOnRead ? buffer.slice(0) : buffer);
            }, (error) => {
                if (release()) reject(error);
            });
        });
    }

    _touchMemory(key, entry) {
        if (!entry.settled) return;
        this._memory.delete(key);
        this._memory.set(key, entry);
    }

    _evictMemory() {
        if (this._memoryBytes <= this._maxMemoryBytes) return;
        for (const [key, entry] of this._memory) {
            if (this._memoryBytes <= this._maxMemoryBytes) break;
            if (!entry.settled || entry.waiters > 0) continue;
            this._memory.delete(key);
            this._memoryBytes = Math.max(0, this._memoryBytes - entry.size);
        }
    }

    _isExpired(expiresAt) {
        return Number.isFinite(expiresAt) && expiresAt <= Date.now();
    }

    _effectiveExpiry(record, policy) {
        const writtenAt = Number(record.cachedAt ?? record.ts) || 0;
        const storedExpiry = record.expiresAt;
        let expiresAt = storedExpiry === null || storedExpiry === undefined ? null : Number(storedExpiry);
        if (expiresAt !== null && !Number.isFinite(expiresAt)) expiresAt = null;
        if (policy.maxAgeMs !== null) {
            const capped = writtenAt + policy.maxAgeMs;
            expiresAt = expiresAt === null ? capped : Math.min(expiresAt, capped);
        }
        return expiresAt;
    }

    _responseCacheMetadata(response, policy, now = Date.now()) {
        const cacheControl = response.headers?.get?.('cache-control') ?? '';
        const directives = cacheControl.toLowerCase().split(',').map(value => value.trim());
        const noStore = directives.includes('no-store');
        // `no-cache` requires validation before reuse. `must-revalidate` only
        // forbids serving the response once its normal freshness lifetime has
        // elapsed; it does not make a positive max-age immediately stale.
        const requiresValidation = directives.includes('no-cache');
        const maxAgeDirective = directives.find(value => /^max-age\s*=/.test(value));
        const maxAgeSeconds = maxAgeDirective ? Number(maxAgeDirective.split('=')[1]?.replaceAll('"', '')) : NaN;
        const ageSeconds = Math.max(0, Number(response.headers?.get?.('age')) || 0);
        let expiresAt = null;
        if (requiresValidation) {
            expiresAt = now;
        } else if (Number.isFinite(maxAgeSeconds)) {
            expiresAt = now + Math.max(0, maxAgeSeconds - ageSeconds) * 1000;
        } else {
            const expires = Date.parse(response.headers?.get?.('expires') ?? '');
            if (Number.isFinite(expires)) expiresAt = expires;
        }
        if (policy.maxAgeMs !== null) {
            const capped = now + policy.maxAgeMs;
            expiresAt = expiresAt === null ? capped : Math.min(expiresAt, capped);
        }
        return {
            cacheable: !noStore,
            cachedAt: now,
            expiresAt,
            etag: response.headers?.get?.('etag') ?? null,
            lastModified: response.headers?.get?.('last-modified') ?? null
        };
    }

    async _readOrFetch(policy, url, init, signal) {
        const key = policy.key;
        let staleRecord = null;
        if (this._persistent) {
            const cached = await this._dbGet(key);
            if (cached && !this._isExpired(this._effectiveExpiry(cached, policy))) {
                if (signal.aborted) throw abortError();
                this._note('l2Hits');
                this._note('bytesFromL2', cached.bytes.byteLength);
                this._dbTouch(key, cached.size ?? cached.bytes.byteLength).catch(() => {});
                return {
                    buffer: cached.bytes,
                    expiresAt: this._effectiveExpiry(cached, policy),
                    cacheable: true
                };
            }
            if (cached) {
                staleRecord = cached;
                this._note('staleEntries');
            }
        }
        if (signal.aborted) throw abortError();
        this._note('misses');
        this._note('networkFetches');
        let requestInit = cloneFetchInit(init, signal);
        if (staleRecord?.etag || staleRecord?.lastModified) {
            const headers = new Headers(requestInit?.headers ?? {});
            if (staleRecord.etag) headers.set('If-None-Match', staleRecord.etag);
            if (staleRecord.lastModified) headers.set('If-Modified-Since', staleRecord.lastModified);
            requestInit = { ...(requestInit ?? {}), headers };
            this._note('revalidations');
        }
        const response = await globalThis.fetch(url, requestInit);
        if (response.status === 304 && staleRecord) {
            const metadata = this._responseCacheMetadata(response, policy);
            const refreshed = {
                ...staleRecord,
                ...metadata,
                expiresAt: metadata.expiresAt ?? (Date.now() + (policy.maxAgeMs ?? 0))
            };
            this._note('revalidationHits');
            this._note('bytesFromL2', staleRecord.bytes.byteLength);
            if (this._persistent) this._dbPut(key, staleRecord.bytes, refreshed).catch(() => {});
            return { buffer: staleRecord.bytes, expiresAt: refreshed.expiresAt, cacheable: true };
        }
        if (!response.ok) throw await buildHttpError(response, url);
        const buffer = await response.arrayBuffer();
        const metadata = this._responseCacheMetadata(response, policy);
        this._note('bytesFromNetwork', buffer.byteLength);
        if (this._persistent && metadata.cacheable) this._dbPut(key, buffer, metadata).catch(() => {});
        return { buffer, expiresAt: metadata.expiresAt, cacheable: metadata.cacheable };
    }

    _note(name, amount = 1) {
        this._counters[name] = (this._counters[name] ?? 0) + amount;
        this._onEvent?.(name, amount);
    }

    async clear() {
        for (const entry of this._memory.values()) {
            if (!entry.settled) entry.controller.abort();
        }
        this._memory.clear();
        this._memoryBytes = 0;
        if (this._persistent) await this._dbClear();
    }

    async size() {
        if (!this._persistent) return 0;
        await this._ensureTotal();
        return this._totalBytes ?? 0;
    }

    async requestPersistence() {
        try {
            this._persistentGranted = !!(await globalThis.navigator?.storage?.persist?.());
        } catch {
            this._persistentGranted = false;
        }
        return this._persistentGranted;
    }

    async getStats() {
        if (this._persistent) await this._ensureTotal();
        return this.snapshot();
    }

    snapshot() {
        const total = this._counters.l1Hits + this._counters.l2Hits + this._counters.misses;
        return {
            ...this._counters,
            hitRate: total > 0 ? (this._counters.l1Hits + this._counters.l2Hits) / total : 0,
            missRate: total > 0 ? this._counters.misses / total : 0,
            memoryBytes: this._memoryBytes,
            memoryEntries: this._memory.size,
            persistentBytes: this._totalBytes ?? 0,
            maxMemoryBytes: this._maxMemoryBytes,
            maxPersistentBytes: this._maxBytes,
            quotaBytes: this._quotaBytes,
            persistent: this._persistent,
            copyOnRead: this._copyOnRead,
            persistentGranted: this._persistentGranted,
            lastWriteError: this._lastWriteError,
            schemaVersion: DB_VERSION
        };
    }

    _getDb() {
        if (this._dbPromise) return this._dbPromise;
        this._dbPromise = new Promise((resolve, reject) => {
            if (typeof indexedDB === 'undefined') {
                reject(new Error('IndexedDB unavailable'));
                return;
            }
            const request = indexedDB.open(this._dbName, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(this._storeName)) {
                    const store = db.createObjectStore(this._storeName, { keyPath: 'url' });
                    store.createIndex('ts', 'ts');
                } else {
                    const transaction = request.transaction;
                    const store = transaction.objectStore(this._storeName);
                    if (!store.indexNames.contains('ts')) store.createIndex('ts', 'ts');
                }
                if (!db.objectStoreNames.contains(this._metaStoreName)) {
                    const metadata = db.createObjectStore(this._metaStoreName, { keyPath: 'url' });
                    metadata.createIndex('ts', 'ts');
                }
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
        });
        this._dbPromise.catch(() => {
            this._dbPromise = null;
        });
        return this._dbPromise;
    }

    async _dbGet(key) {
        try {
            const db = await this._getDb();
            const record = await new Promise((resolve) => {
                const transaction = db.transaction(this._storeName, 'readonly');
                const request = transaction.objectStore(this._storeName).get(key);
                request.onsuccess = () => resolve(request.result ?? null);
                request.onerror = () => resolve(null);
            });
            return record?.bytes ? record : null;
        } catch {
            return null;
        }
    }

    async _dbTouch(key, size) {
        const db = await this._getDb();
        const transaction = db.transaction(this._metaStoreName, 'readwrite');
        transaction.objectStore(this._metaStoreName).put({ url: key, ts: Date.now(), size });
    }

    async _dbPut(key, bytes, metadata = {}) {
        try {
            const db = await this._getDb();
            await this._ensureTotal();
            const size = bytes.byteLength;
            if (this._quotaBytes && (this._totalBytes ?? 0) + size > this._quotaBytes * 0.9) {
                await this._evictUntilUnderCap(db, Math.min(this._maxBytes, this._quotaBytes * 0.8 - size));
            }
            const result = await new Promise((resolve) => {
                let previousSize = 0;
                const transaction = db.transaction([this._storeName, this._metaStoreName], 'readwrite');
                transaction.oncomplete = () => resolve({ ok: true, previousSize });
                transaction.onabort = () => resolve({ ok: false, error: transaction.error, previousSize: 0 });
                transaction.onerror = () => {};
                const store = transaction.objectStore(this._storeName);
                const existing = store.get(key);
                existing.onsuccess = () => {
                    previousSize = existing.result?.size ?? existing.result?.bytes?.byteLength ?? 0;
                    const timestamp = Date.now();
                    store.put({
                        url: key,
                        bytes,
                        ts: timestamp,
                        size,
                        cachedAt: metadata.cachedAt ?? timestamp,
                        expiresAt: metadata.expiresAt,
                        etag: metadata.etag ?? null,
                        lastModified: metadata.lastModified ?? null
                    });
                    transaction.objectStore(this._metaStoreName).put({ url: key, ts: timestamp, size });
                };
            });
            if (!result.ok) {
                this._lastWriteError = result.error?.name ?? result.error?.message ?? 'IndexedDB write failed';
                this._note('failedWrites');
                await this._refreshEstimate();
                return false;
            }
            this._totalBytes = Math.max(0, (this._totalBytes ?? 0) + size - result.previousSize);
            this._lastWriteError = null;
            if (this._totalBytes > this._maxBytes) this._evictUntilUnderCap(db, this._maxBytes).catch(() => {});
            return true;
        } catch (error) {
            this._lastWriteError = error?.name ?? error?.message ?? 'IndexedDB unavailable';
            this._note('failedWrites');
            return false;
        }
    }

    async _refreshEstimate() {
        try {
            const estimate = await globalThis.navigator?.storage?.estimate?.();
            this._quotaBytes = estimate?.quota ?? this._quotaBytes;
        } catch { /* retain previous estimate */ }
    }

    _ensureTotal() {
        if (this._totalBytesInit) return this._totalBytesInit;
        this._totalBytesInit = (async () => {
            try {
                const db = await this._getDb();
                this._totalBytes = await new Promise((resolve) => {
                    let total = 0;
                    const transaction = db.transaction(this._metaStoreName, 'readonly');
                    const cursor = transaction.objectStore(this._metaStoreName).openCursor();
                    cursor.onsuccess = (event) => {
                        const entry = event.target.result;
                        if (!entry) return;
                        total += entry.value.size ?? 0;
                        entry.continue();
                    };
                    transaction.oncomplete = () => resolve(total);
                    transaction.onabort = () => resolve(0);
                    transaction.onerror = () => {};
                });
                await this._refreshEstimate();
            } catch {
                this._totalBytes = 0;
            }
        })();
        return this._totalBytesInit;
    }

    async _evictUntilUnderCap(db, targetBytes = this._maxBytes) {
        if (this._evicting) return;
        this._evicting = true;
        try {
            while ((this._totalBytes ?? 0) > Math.max(0, targetBytes)) {
                // eslint-disable-next-line no-await-in-loop
                let removed = await this._evictOldestMetadata(db);
                // Version-1 rows have no separate metadata until first read.
                // Fall back to their original write timestamp during migration.
                if (!removed.found) {
                    // eslint-disable-next-line no-await-in-loop
                    removed = await this._evictOldestLegacy(db);
                }
                if (!removed.found) break;
                this._totalBytes = Math.max(0, this._totalBytes - removed.size);
                this._note('evictions');
            }
        } finally {
            this._evicting = false;
        }
    }

    _evictOldestMetadata(db) {
        return new Promise((resolve) => {
            let result = { found: false, size: 0 };
            const transaction = db.transaction([this._storeName, this._metaStoreName], 'readwrite');
            const cursor = transaction.objectStore(this._metaStoreName).index('ts').openCursor();
            cursor.onsuccess = (event) => {
                const entry = event.target.result;
                if (!entry || result.found) return;
                result = { found: true, size: entry.value.size ?? 0 };
                transaction.objectStore(this._storeName).delete(entry.primaryKey);
                entry.delete();
            };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => resolve({ found: false, size: 0 });
            transaction.onerror = () => {};
        });
    }

    _evictOldestLegacy(db) {
        return new Promise((resolve) => {
            let result = { found: false, size: 0 };
            const transaction = db.transaction(this._storeName, 'readwrite');
            const cursor = transaction.objectStore(this._storeName).index('ts').openCursor();
            cursor.onsuccess = (event) => {
                const entry = event.target.result;
                if (!entry || result.found) return;
                result = { found: true, size: entry.value.size ?? entry.value.bytes?.byteLength ?? 0 };
                entry.delete();
            };
            transaction.oncomplete = () => resolve(result);
            transaction.onabort = () => resolve({ found: false, size: 0 });
            transaction.onerror = () => {};
        });
    }

    async _dbClear() {
        try {
            const db = await this._getDb();
            await new Promise((resolve) => {
                const transaction = db.transaction([this._storeName, this._metaStoreName], 'readwrite');
                transaction.objectStore(this._storeName).clear();
                transaction.objectStore(this._metaStoreName).clear();
                transaction.oncomplete = () => resolve();
                transaction.onabort = () => resolve();
                transaction.onerror = () => {};
            });
            this._totalBytes = 0;
            this._totalBytesInit = null;
        } catch { /* cache clear cannot break rendering */ }
    }
}

export { TileCache };
