// Frame-budgeted priority queue for heavy per-tile work -- typically
// `pc.Asset.resource.instantiateRenderEntity()`, which parses the GLB into
// PlayCanvas mesh/material/texture instances and uploads to the GPU. On a
// burst (a cache rush, a pan that completes hundreds of downloads in one
// frame), doing N instantiations back-to-back in the load handler stalls the
// frame for 50-200 ms easily.
//
// Pattern: instead of instantiating inside the tile `load` handler, push a
// callback here, then drain the queue with a millisecond budget from
// `app.on('update')`. The heap orders work by caller-supplied priority so
// pans-into-view get instantiated before pans-out-of-view that completed
// download just before the camera turned.
//
// Exposed as terratile.TileInstantiationQueue.
//
// Pure JS (no PlayCanvas API references) -- it just runs callbacks on a
// budget. Lives here for naming clarity / discoverability alongside the other
// PlayCanvas-flavoured helpers.

(function () {
    if (typeof terratile === 'undefined') throw new Error('tile-instantiation-queue: terratile is not loaded');

    /**
     * Priority queue with a per-frame time budget. Push `(priority, runFn)`
     * pairs from anywhere (typically a tile `load` handler that just finished
     * downloading bytes); call `flush()` once per frame from the app update
     * loop to drain as many jobs as fit in `budgetMs`.
     */
    class TileInstantiationQueue {
        /**
         * @param {object} [opts] - Constructor options.
         * @param {number} [opts.budgetMs] - Maximum wall-clock time per
         * `flush()` call, in milliseconds (default 6). Tune up for faster
         * bursts at the cost of occasional frame hitches; down for steadier
         * pacing at the cost of longer tail latency.
         */
        constructor({ budgetMs = 6 } = {}) {
            this._budgetMs = budgetMs;
            this._heap = [];
        }

        /**
         * Enqueue a job. Higher `priority` runs first. `runFn` is called
         * synchronously when the job is drained; any thrown error is logged
         * and swallowed so one bad job doesn't break the queue.
         *
         * @param {number} priority - Caller-supplied priority; higher = sooner.
         * @param {() => void} runFn - The work to do (typically the
         * `instantiateRenderEntity` + scene-graph wiring step).
         */
        push(priority, runFn) {
            this._heap.push({ priority, runFn });
            let i = this._heap.length - 1;
            while (i > 0) {
                const parent = (i - 1) >> 1;
                if (this._heap[parent].priority >= this._heap[i].priority) break;
                const tmp = this._heap[parent];
                this._heap[parent] = this._heap[i];
                this._heap[i] = tmp;
                i = parent;
            }
        }

        _pop() {
            if (this._heap.length === 0) return null;
            const top = this._heap[0];
            const last = this._heap.pop();
            if (this._heap.length > 0) {
                this._heap[0] = last;
                let i = 0;
                const n = this._heap.length;
                while (true) {
                    let largest = i;
                    const l = 2 * i + 1;
                    const r = 2 * i + 2;
                    if (l < n && this._heap[l].priority > this._heap[largest].priority) largest = l;
                    if (r < n && this._heap[r].priority > this._heap[largest].priority) largest = r;
                    if (largest === i) break;
                    const tmp = this._heap[i];
                    this._heap[i] = this._heap[largest];
                    this._heap[largest] = tmp;
                    i = largest;
                }
            }
            return top;
        }

        /**
         * Drain jobs in priority order until the time budget is exhausted or
         * the queue is empty. Call once per frame from your update loop.
         *
         * @returns {number} How many jobs ran this call.
         */
        flush() {
            const deadline = performance.now() + this._budgetMs;
            let count = 0;
            while (this._heap.length > 0 && performance.now() < deadline) {
                const job = this._pop();
                try {
                    job.runFn();
                } catch (e) {
                    console.error('TileInstantiationQueue job failed:', e);
                }
                count++;
            }
            return count;
        }

        /**
         * Current pending-job count.
         *
         * @returns {number} The heap size.
         */
        get size() {
            return this._heap.length;
        }

        /**
         * Update the per-flush time budget. Takes effect on the next `flush()`.
         *
         * @param {number} ms - New budget in milliseconds.
         */
        setBudget(ms) {
            if (Number.isFinite(ms) && ms > 0) this._budgetMs = ms;
        }

        /**
         * Drop every pending job without running them. Use when the consumer
         * tears down or hard-resets the scene.
         */
        clear() {
            this._heap.length = 0;
        }
    }

    terratile.TileInstantiationQueue = TileInstantiationQueue;
})();
