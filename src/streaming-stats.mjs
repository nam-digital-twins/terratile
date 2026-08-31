const TILE_LOAD_STAGES = Object.freeze({
    REQUESTED: 'requested',
    DOWNLOADING: 'downloading',
    DOWNLOADED: 'downloaded',
    DECODING: 'decoding',
    DECODED: 'decoded',
    PREPARING: 'preparing',
    RENDER_READY: 'renderReady',
    VISIBLE: 'visible',
    RESIDENT: 'resident'
});

const DEFAULT_METRICS = Object.freeze([
    'downloadMs',
    'decodeMs',
    'prepareMs',
    'instantiateMs',
    'textureUploadMs'
]);

const DEFAULT_COUNTERS = Object.freeze([
    'requested',
    'completed',
    'cancelled',
    'superseded',
    'staleDropped',
    'failed',
    'networkBytes',
    'cacheL1Hits',
    'cacheL2Hits',
    'cacheMisses',
    'cacheEvictions',
    'cacheFailedWrites',
    'longTasks'
]);

function createMetric() {
    return {
        count: 0,
        total: 0,
        max: 0,
        samples: []
    };
}

function percentile(sorted, fraction) {
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
    return sorted[Math.max(0, index)];
}

/**
 * Mutable streaming telemetry accumulator used by TileManager and renderer
 * integrations. Snapshot objects are detached from internal state and safe for
 * HUDs, logs and tests to retain.
 */
class StreamingStats {
    /**
     * @param {object} [options] - Statistics options.
     * @param {number} [options.sampleLimit] - Retained samples per timing
     * metric for percentile calculation.
     */
    constructor({ sampleLimit = 256 } = {}) {
        this._sampleLimit = Math.max(8, Math.floor(sampleLimit));
        this._nodeStages = new WeakMap();
        this._stageCounts = new Map();
        this._metrics = new Map(DEFAULT_METRICS.map(name => [name, createMetric()]));
        this._counters = Object.fromEntries(DEFAULT_COUNTERS.map(name => [name, 0]));
        this._gauges = {
            activeNetwork: 0,
            queuedNetwork: 0,
            activeDecode: 0,
            queuedDecode: 0,
            queuedPrepare: 0,
            downloadedBytes: 0,
            decodedBytes: 0,
            residentCount: 0,
            residentSourceBytes: 0,
            residentGpuBytes: 0,
            dracoWorkers: 0,
            basisWorkers: 0
        };
    }

    setStage(node, stage) {
        if (!node) return;
        const previous = this._nodeStages.get(node);
        if (previous === stage) return;
        if (previous) {
            const count = (this._stageCounts.get(previous) ?? 1) - 1;
            if (count > 0) this._stageCounts.set(previous, count);
            else this._stageCounts.delete(previous);
        }
        if (stage) {
            this._nodeStages.set(node, stage);
            this._stageCounts.set(stage, (this._stageCounts.get(stage) ?? 0) + 1);
        } else {
            this._nodeStages.delete(node);
        }
    }

    getStage(node) {
        return this._nodeStages.get(node) ?? null;
    }

    clearNode(node) {
        this.setStage(node, null);
    }

    record(name, milliseconds) {
        if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
        let metric = this._metrics.get(name);
        if (!metric) {
            metric = createMetric();
            this._metrics.set(name, metric);
        }
        metric.count++;
        metric.total += milliseconds;
        metric.max = Math.max(metric.max, milliseconds);
        metric.samples.push(milliseconds);
        if (metric.samples.length > this._sampleLimit) metric.samples.shift();
    }

    increment(name, amount = 1) {
        if (!Number.isFinite(amount)) return;
        this._counters[name] = (this._counters[name] ?? 0) + amount;
    }

    setGauge(name, value) {
        if (!Number.isFinite(value)) return;
        this._gauges[name] = value;
    }

    snapshot(extra = null) {
        const timings = {};
        for (const [name, metric] of this._metrics) {
            const sorted = metric.samples.slice().sort((a, b) => a - b);
            timings[name] = {
                count: metric.count,
                average: metric.count > 0 ? metric.total / metric.count : 0,
                max: metric.max,
                p50: percentile(sorted, 0.50),
                p95: percentile(sorted, 0.95),
                p99: percentile(sorted, 0.99)
            };
        }
        return {
            stages: Object.fromEntries(this._stageCounts),
            queues: { ...this._gauges },
            counters: { ...this._counters },
            timings,
            ...(extra ?? {})
        };
    }
}

export { StreamingStats, TILE_LOAD_STAGES };
