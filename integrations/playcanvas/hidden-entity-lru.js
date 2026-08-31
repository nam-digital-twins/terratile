// Entity-level LRU cache for tiles that have been "unloaded" from the active
// scene. Parks the parsed `pc.Entity` (and the `pc.Asset` it came from) in a
// Map up to a cap. Revisits skip the GLB parse + GPU upload entirely -- they
// just flip `entity.enabled` back on.
//
// Composes with terratile's existing handler model: the consumer's `unload`
// handler parks instead of destroying, and the `load` handler tries to revive
// before fetching. The same consumer should also expose terratile's
// `hasEntity` handler hook (`(node) => nodeToEntity.has(node)`) so the
// selection layer treats parked-and-active and parked-and-hidden tiles
// uniformly when picking ancestors as fallback.
//
// Exposed as terratile.HiddenEntityLRU.
//
// `pc` is referenced only via duck typing (`.destroy()` / `.unload()`); this
// module has no hard dependency on PlayCanvas APIs.

(function () {
    if (typeof terratile === 'undefined') throw new Error('hidden-entity-lru: terratile is not loaded');

    /**
     * Bounded insertion-ordered cache for parked entities. Parking the same
     * key twice bumps it to the freshest position; oldest entries are evicted
     * when the cap is exceeded. Eviction calls the optional `onEvict` hook so
     * the consumer can dispose of the underlying entity + asset.
     */
    class HiddenEntityLRU {
        /**
         * @param {object} [opts] - Constructor options.
         * @param {number} [opts.cap] - Maximum number of parked entries
         * (default 200). When exceeded, the oldest entry is evicted.
         * @param {(value: any, key: any) => void} [opts.onEvict] - Called
         * with `(value, key)` whenever an entry is evicted (cap overflow
         * or `clear()`). Typical implementation: `(v) => { v.entity.destroy();
         * v.asset?.unload(); }`. No-op if omitted.
         */
        constructor({ cap = 200, onEvict = null } = {}) {
            this._cap = cap;
            this._onEvict = onEvict;
            this._map = new Map();   // key -> arbitrary value (typically { entity, asset })
        }

        /**
         * Park a value under `key`. Re-parking an existing key bumps it to
         * the freshest position. Evicts the oldest entry if the cap is full.
         *
         * @param {*} key - Caller's id (typically the tile `node` reference).
         * @param {*} value - The value to store (typically `{ entity, asset }`).
         */
        park(key, value) {
            if (this._map.has(key)) this._map.delete(key);
            this._map.set(key, value);
            while (this._map.size > this._cap) {
                const oldestKey = this._map.keys().next().value;
                if (oldestKey === undefined) break;
                const oldest = this._map.get(oldestKey);
                this._map.delete(oldestKey);
                if (this._onEvict) {
                    try {
                        this._onEvict(oldest, oldestKey);
                    } catch (e) {
                        console.error('HiddenEntityLRU onEvict failed:', e);
                    }
                }
            }
        }

        /**
         * Look up and remove the parked value for `key`. Returns `null` if
         * the key is not parked.
         *
         * @param {*} key - Caller's id.
         * @returns {*} The previously-parked value, or `null`.
         */
        revive(key) {
            if (!this._map.has(key)) return null;
            const value = this._map.get(key);
            this._map.delete(key);
            return value;
        }

        /**
         * @param {*} key - Caller's id.
         * @returns {boolean} true if `key` is currently parked.
         */
        has(key) {
            return this._map.has(key);
        }

        /**
         * Current number of parked entries.
         *
         * @returns {number} The size of the LRU.
         */
        get size() {
            return this._map.size;
        }

        /**
         * Iterate parked values in oldest-first order (use for bulk operations
         * such as re-skinning every parked entity when a render mode changes).
         *
         * @returns {IterableIterator<*>} Values iterator.
         */
        values() {
            return this._map.values();
        }

        /**
         * Iterate `[key, value]` pairs in oldest-first order.
         *
         * @returns {IterableIterator<[*, *]>} Entries iterator.
         */
        entries() {
            return this._map.entries();
        }

        /**
         * Evict every parked entry (firing `onEvict` on each) and reset the
         * cache to empty.
         */
        clear() {
            if (this._onEvict) {
                for (const [k, v] of this._map) {
                    try {
                        this._onEvict(v, k);
                    } catch (e) {
                        console.error('HiddenEntityLRU onEvict failed:', e);
                    }
                }
            }
            this._map.clear();
        }
    }

    terratile.HiddenEntityLRU = HiddenEntityLRU;
})();
