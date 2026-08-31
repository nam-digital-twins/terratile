const DEFAULT_DB_NAME = 'terratile-derived-cache';
const DEFAULT_STORE = 'resources';
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_MEMORY_BYTES = 128 * 1024 * 1024;

function requestPromise(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
}

function transactionPromise(transaction) {
    return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
        transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
}

/**
 * Persistent structured-clone cache for engine-derived tile resources.
 *
 * Unlike TileCache, which stores original network bytes, this cache stores
 * parser output such as tightly packed vertex/index streams and embedded image
 * bytes. Entries are versioned by their caller-provided key so parser schema or
 * engine changes can invalidate them without rewriting the byte cache.
 */
class DerivedResourceCache {
    constructor({
        dbName = DEFAULT_DB_NAME,
        storeName = DEFAULT_STORE,
        maxBytes = DEFAULT_MAX_BYTES,
        maxMemoryBytes = DEFAULT_MAX_MEMORY_BYTES,
        // Derived renderer resources are page-session-local by default.
        // Cross-session reuse must be explicitly enabled by the consumer.
        persistent = false
    } = {}) {
        this.dbName = dbName;
        this.storeName = storeName;
        this.maxBytes = Math.max(0, Number(maxBytes) || 0);
        this.maxMemoryBytes = Math.max(0, Number(maxMemoryBytes) || 0);
        this.persistent = persistent;
        this.memory = new Map();
        this.memoryBytes = 0;
        this.dbPromise = null;
        this.totalBytes = null;
        this.stats = {
            memoryHits: 0,
            persistentHits: 0,
            misses: 0,
            writes: 0,
            evictions: 0,
            failedWrites: 0
        };
    }

    async get(key) {
        if (!key) return null;
        const memory = this.memory.get(key);
        if (memory) {
            this.memory.delete(key);
            this.memory.set(key, memory);
            memory.at = Date.now();
            this.stats.memoryHits++;
            return memory.value;
        }
        if (this.persistent) {
            try {
                const db = await this._open();
                const transaction = db.transaction(this.storeName, 'readonly');
                const record = await requestPromise(transaction.objectStore(this.storeName).get(key));
                if (record?.value) {
                    this.stats.persistentHits++;
                    this._remember(key, record.value, record.size ?? 0);
                    this._touch(key).catch(() => {});
                    return record.value;
                }
            } catch {
                // Persistent-cache failure never blocks rendering.
            }
        }
        this.stats.misses++;
        return null;
    }

    async put(key, value, size = 0) {
        if (!key || value == null) return;
        const entrySize = Math.max(0, Number(size) || 0);
        this._remember(key, value, entrySize);
        if (!this.persistent || this.maxBytes === 0) return;
        try {
            const db = await this._open();
            const previousTotal = await this._getTotalBytes();
            const transaction = db.transaction(this.storeName, 'readwrite');
            const store = transaction.objectStore(this.storeName);
            const previous = await requestPromise(store.get(key));
            store.put({ key, value, size: entrySize, at: Date.now() });
            await transactionPromise(transaction);
            this.totalBytes = previousTotal - (previous?.size ?? 0) + entrySize;
            this.stats.writes++;
            await this._evictPersistent();
        } catch {
            this.stats.failedWrites++;
        }
    }

    async clear() {
        this.memory.clear();
        this.memoryBytes = 0;
        this.totalBytes = 0;
        if (!this.persistent) return;
        const db = await this._open();
        const transaction = db.transaction(this.storeName, 'readwrite');
        transaction.objectStore(this.storeName).clear();
        await transactionPromise(transaction);
    }

    snapshot() {
        return {
            ...this.stats,
            memoryEntries: this.memory.size,
            memoryBytes: this.memoryBytes,
            persistentBytes: this.totalBytes ?? 0,
            maxBytes: this.maxBytes,
            maxMemoryBytes: this.maxMemoryBytes,
            persistent: this.persistent
        };
    }

    _remember(key, value, size) {
        const previous = this.memory.get(key);
        if (previous) this.memoryBytes -= previous.size;
        this.memory.delete(key);
        this.memory.set(key, { value, size, at: Date.now() });
        this.memoryBytes += size;
        while (this.memoryBytes > this.maxMemoryBytes && this.memory.size > 0) {
            const oldestKey = this.memory.keys().next().value;
            const oldest = this.memory.get(oldestKey);
            this.memory.delete(oldestKey);
            this.memoryBytes = Math.max(0, this.memoryBytes - (oldest?.size ?? 0));
        }
    }

    _open() {
        if (!globalThis.indexedDB) throw new Error('IndexedDB unavailable');
        if (!this.dbPromise) {
            this.dbPromise = new Promise((resolve, reject) => {
                const request = globalThis.indexedDB.open(this.dbName, 1);
                request.onupgradeneeded = () => {
                    const db = request.result;
                    const store = db.objectStoreNames.contains(this.storeName) ?
                        request.transaction.objectStore(this.storeName) :
                        db.createObjectStore(this.storeName, { keyPath: 'key' });
                    if (!store.indexNames.contains('at')) store.createIndex('at', 'at');
                };
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
            });
        }
        return this.dbPromise;
    }

    async _touch(key) {
        const db = await this._open();
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const record = await requestPromise(store.get(key));
        if (record) {
            record.at = Date.now();
            store.put(record);
        }
        await transactionPromise(transaction);
    }

    async _getTotalBytes() {
        if (this.totalBytes != null) return this.totalBytes;
        const db = await this._open();
        const transaction = db.transaction(this.storeName, 'readonly');
        const request = transaction.objectStore(this.storeName).openCursor();
        let total = 0;
        await new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) {
                    resolve();
                    return;
                }
                total += Number(cursor.value?.size) || 0;
                cursor.continue();
            };
            request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
        });
        this.totalBytes = total;
        return total;
    }

    async _evictPersistent() {
        if ((this.totalBytes ?? 0) <= this.maxBytes) return;
        const db = await this._open();
        const transaction = db.transaction(this.storeName, 'readwrite');
        const store = transaction.objectStore(this.storeName);
        const request = store.index('at').openCursor();
        await new Promise((resolve, reject) => {
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor || this.totalBytes <= this.maxBytes) {
                    resolve();
                    return;
                }
                const record = cursor.value;
                this.totalBytes = Math.max(0, this.totalBytes - (Number(record?.size) || 0));
                const memory = this.memory.get(record.key);
                if (memory) {
                    this.memory.delete(record.key);
                    this.memoryBytes = Math.max(0, this.memoryBytes - memory.size);
                }
                cursor.delete();
                this.stats.evictions++;
                cursor.continue();
            };
            request.onerror = () => reject(request.error ?? new Error('IndexedDB eviction failed'));
        });
        await transactionPromise(transaction);
    }
}

export { DerivedResourceCache };
