import assert from 'node:assert/strict';
import test from 'node:test';

import { StreamingStats, TILE_LOAD_STAGES, TileCache, TileManager } from '../src/index.mjs';

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function makeNode(name, geometricError, children = []) {
    const node = {
        name,
        geometricError,
        boundingVolume: {
            box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10]
        },
        __baseUrl: 'https://example.invalid/',
        content: { uri: `https://example.invalid/${name}.glb` },
        children
    };
    for (const child of children) child.__parent = node;
    return node;
}

function selectFrame(manager) {
    manager._frameNumber++;
    return manager._select([0, 0, 100], Math.PI / 3, 1000, null);
}

test('desktop streaming defaults retain 128 network slots and admit all configured decode workers', () => {
    const source = {
        getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
        resolveRequest: url => ({ url })
    };
    const manager = new TileManager(source, {
        workerProfile: { dracoWorkers: 12, basisWorkers: 6 }
    });

    assert.equal(manager.maxConcurrentRequests, 128);
    assert.equal(manager.maxConcurrentDecodes, 18);
});

test('transient startup failures back off and recover without an SSE change', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount++;
        if (fetchCount <= 5) throw new TypeError('startup socket contention');
        return new Response(new Uint8Array([1, 2, 3]));
    };
    try {
        const node = makeNode('retry-after-contention', 10);
        const active = new Set();
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            decode: async (_node, bytes) => bytes,
            prepare: async preparedNode => active.add(preparedNode),
            hasEntity: preparedNode => active.has(preparedNode),
            hide: () => {},
            show: () => {},
            unload: preparedNode => active.delete(preparedNode)
        });
        manager.retryBaseDelayMs = 0;
        manager.retryMaxDelayMs = 0;

        for (let attempt = 0; attempt < 6; attempt++) {
            // eslint-disable-next-line no-await-in-loop
            await manager.loadContent(node, 10);
        }

        assert.equal(fetchCount, 6);
        assert.equal(manager._isEntityReady(node), true);
        assert.equal(node.__contentLoaded, true);
        assert.equal(node.__loadDead, undefined);
        assert.equal(node.__loadFailures, 0);
        const stats = manager.getStreamingStats();
        assert.equal(stats.counters.retryScheduled, 5);
        assert.equal(stats.counters.retryRecovered, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('basemap tile requests use high browser network priority', async () => {
    const originalFetch = globalThis.fetch;
    let browserPriority = null;
    globalThis.fetch = async (_url, init) => {
        browserPriority = init?.priority ?? null;
        return new Response(new Uint8Array([1, 2, 3]));
    };
    try {
        const node = makeNode('network-priority', 10);
        const active = new Set();
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            decode: async (_node, bytes) => bytes,
            prepare: async preparedNode => active.add(preparedNode),
            hasEntity: preparedNode => active.has(preparedNode),
            hide: () => {},
            show: () => {},
            unload: preparedNode => active.delete(preparedNode)
        });

        await manager.loadContent(node, 10, 'visible');

        assert.equal(browserPriority, 'high');
        assert.equal(manager._isEntityReady(node), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('streaming statistics expose stage counts and timing percentiles', () => {
    const stats = new StreamingStats({ sampleLimit: 16 });
    const a = {};
    const b = {};
    stats.setStage(a, TILE_LOAD_STAGES.DOWNLOADING);
    stats.setStage(b, TILE_LOAD_STAGES.DOWNLOADING);
    stats.setStage(a, TILE_LOAD_STAGES.DECODING);
    for (const value of [1, 2, 3, 4, 100]) stats.record('decodeMs', value);
    stats.increment('cancelled', 2);
    stats.setGauge('activeDecode', 3);

    const snapshot = stats.snapshot();

    assert.deepEqual(snapshot.stages, { downloading: 1, decoding: 1 });
    assert.equal(snapshot.counters.cancelled, 2);
    assert.equal(snapshot.queues.activeDecode, 3);
    assert.equal(snapshot.timings.decodeMs.count, 5);
    assert.equal(snapshot.timings.decodeMs.max, 100);
    assert.equal(snapshot.timings.decodeMs.p50, 3);
    assert.equal(snapshot.timings.decodeMs.p95, 100);
});

test('staged loading releases the network slot before preparation and preserves parent coverage', async () => {
    const originalFetch = globalThis.fetch;
    const prepareGate = deferred();
    const prepareStarted = deferred();
    const secondFetched = deferred();
    const active = new Set();
    const fetches = [];

    globalThis.fetch = async (url) => {
        fetches.push(url);
        if (String(url).includes('/b.glb')) secondFetched.resolve();
        return new Response(new Uint8Array([1, 2, 3, 4]));
    };

    try {
        const a = makeNode('a', 10);
        const b = makeNode('b', 10);
        const parent = makeNode('parent', 100, [a, b]);
        active.add(parent);
        active.add(b);

        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            decode: async (_node, bytes) => ({ bytes, byteLength: bytes.byteLength * 2 }),
            getDecodedByteLength: (_node, decoded) => decoded.byteLength,
            prepare: async (node) => {
                if (node === a) {
                    prepareStarted.resolve();
                    await prepareGate.promise;
                }
                active.add(node);
            },
            hasEntity: node => active.has(node),
            hide: () => {},
            show: () => {},
            unload: node => active.delete(node)
        });
        manager.maxConcurrentRequests = 1;
        manager.maxConcurrentDecodes = 1;
        manager.refinementMode = 'atomic';
        manager.maximumScreenSpaceError = 16;
        manager.maxFallbackSseFactor = 8;
        manager._frameSseDenom = 2 * Math.tan(Math.PI / 6);
        manager._root = parent;

        const firstLoad = manager.loadContent(a, 10);
        await prepareStarted.promise;

        assert.equal(manager.getLoadStage(a), TILE_LOAD_STAGES.PREPARING);
        assert.equal(manager._activeRequests, 0);
        assert.equal(manager._isEntityReady(a), false);

        const duringPrepare = selectFrame(manager);
        assert.deepEqual([...duringPrepare.selected], [parent]);

        const secondLoad = manager.loadContent(b, 20);
        await secondFetched.promise;
        assert.equal(fetches.length, 2);

        prepareGate.resolve();
        await Promise.all([firstLoad, secondLoad]);

        assert.equal(manager.getLoadStage(a), TILE_LOAD_STAGES.RENDER_READY);
        assert.equal(manager.getLoadStage(b), TILE_LOAD_STAGES.RENDER_READY);
        assert.equal(manager._isEntityReady(a), true);
        const afterPrepare = selectFrame(manager);
        assert.equal(afterPrepare.selected.has(parent), false);
        assert.equal(afterPrepare.selected.has(a), true);
        assert.equal(afterPrepare.selected.has(b), true);

        const stats = manager.getStreamingStats();
        assert.equal(stats.counters.completed, 2);
        assert.equal(stats.timings.downloadMs.count, 2);
        assert.equal(stats.timings.decodeMs.count, 2);
        assert.equal(stats.timings.prepareMs.count, 2);
        assert.equal(stats.queues.activeNetwork, 0);
        assert.equal(stats.queues.downloadedBytes, 0);
        assert.equal(stats.queues.decodedBytes, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('delayed decoding keeps the coarse parent selected until decode and preparation finish', async () => {
    const originalFetch = globalThis.fetch;
    const decodeGate = deferred();
    const active = new Set();
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    try {
        const a = makeNode('decode-a', 10);
        const b = makeNode('decode-b', 10);
        const parent = makeNode('decode-parent', 100, [a, b]);
        active.add(parent);
        active.add(b);
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            decode: async (_node, bytes) => {
                await decodeGate.promise;
                return bytes;
            },
            prepare: async node => active.add(node),
            hasEntity: node => active.has(node),
            hide: () => {},
            show: () => {},
            unload: node => active.delete(node)
        });
        manager.refinementMode = 'atomic';
        manager.maximumScreenSpaceError = 16;
        manager._frameSseDenom = 2 * Math.tan(Math.PI / 6);
        manager._root = parent;

        const loading = manager.loadContent(a, 10);
        while (manager.getLoadStage(a) !== TILE_LOAD_STAGES.DECODING) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        assert.deepEqual([...selectFrame(manager).selected], [parent]);
        decodeGate.resolve();
        await loading;
        const finished = selectFrame(manager);
        assert.equal(finished.selected.has(parent), false);
        assert.equal(finished.selected.has(a), true);
        assert.equal(finished.selected.has(b), true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('cancellation during download retains parent coverage and aborts unused network work', async () => {
    const originalFetch = globalThis.fetch;
    let networkAborted = false;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            networkAborted = true;
            const error = new Error('Aborted');
            error.name = 'AbortError';
            reject(error);
        }, { once: true });
    });
    try {
        const child = makeNode('download-cancel', 10);
        const parent = makeNode('download-cover', 100, [child]);
        const active = new Set([parent]);
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            prepare: async node => active.add(node),
            hasEntity: node => active.has(node),
            hide: () => {},
            show: () => {},
            unload: node => active.delete(node)
        });
        manager.refinementMode = 'atomic';
        manager.maximumScreenSpaceError = 16;
        manager._frameSseDenom = 2 * Math.tan(Math.PI / 6);
        manager._root = parent;
        const loading = manager.loadContent(child, 10);
        while (manager.getLoadStage(child) !== TILE_LOAD_STAGES.DOWNLOADING) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        manager.unloadContent(child);
        await loading;
        assert.equal(networkAborted, true);
        assert.deepEqual([...selectFrame(manager).selected], [parent]);
        assert.equal(manager.getLoadStage(child), null);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('cancellation during decode discards decoded work before preparation and retains coverage', async () => {
    const originalFetch = globalThis.fetch;
    const decodeGate = deferred();
    let prepareCount = 0;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3]));
    try {
        const child = makeNode('decode-cancel', 10);
        const parent = makeNode('decode-cover', 100, [child]);
        const active = new Set([parent]);
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            decode: async (_node, bytes) => {
                await decodeGate.promise;
                return bytes;
            },
            prepare: async node => {
                prepareCount++;
                active.add(node);
            },
            hasEntity: node => active.has(node),
            hide: () => {},
            show: () => {},
            unload: node => active.delete(node)
        });
        manager.refinementMode = 'atomic';
        manager.maximumScreenSpaceError = 16;
        manager._frameSseDenom = 2 * Math.tan(Math.PI / 6);
        manager._root = parent;
        const loading = manager.loadContent(child, 10);
        while (manager.getLoadStage(child) !== TILE_LOAD_STAGES.DECODING) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        manager.unloadContent(child);
        decodeGate.resolve();
        await loading;
        assert.equal(prepareCount, 0);
        assert.deepEqual([...selectFrame(manager).selected], [parent]);
        assert.equal(manager.getLoadStage(child), null);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('download backpressure pauses new fetches until decode capacity drains', async () => {
    const originalFetch = globalThis.fetch;
    const firstDecodeGate = deferred();
    const secondFetched = deferred();
    const thirdFetched = deferred();
    const active = new Set();
    let fetchCount = 0;

    globalThis.fetch = async (url) => {
        fetchCount++;
        if (String(url).includes('/b.glb')) secondFetched.resolve();
        if (String(url).includes('/c.glb')) thirdFetched.resolve();
        return new Response(new Uint8Array([1, 2, 3, 4]));
    };

    try {
        const a = makeNode('a', 10);
        const b = makeNode('b', 10);
        const c = makeNode('c', 10);
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            decode: async (node, bytes) => {
                if (node === a) await firstDecodeGate.promise;
                return bytes;
            },
            prepare: async (node) => active.add(node),
            hasEntity: node => active.has(node),
            hide: () => {},
            show: () => {},
            unload: node => active.delete(node)
        });
        manager.maxConcurrentRequests = 3;
        manager.maxConcurrentDecodes = 1;
        manager.maxDownloadedBytes = 1;

        const loadA = manager.loadContent(a, 1);
        while (manager.getLoadStage(a) !== TILE_LOAD_STAGES.DECODING) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
        const loadB = manager.loadContent(b, 2);
        await secondFetched.promise;
        while (manager.getLoadStage(b) !== TILE_LOAD_STAGES.DOWNLOADED) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        const loadC = manager.loadContent(c, 3);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(fetchCount, 2);
        assert.equal(manager._capacityWaiters.length, 1);

        firstDecodeGate.resolve();
        await thirdFetched.promise;
        await Promise.all([loadA, loadB, loadC]);

        assert.equal(fetchCount, 3);
        assert.equal(manager._capacityWaiters.length, 0);
        assert.equal(manager.getStreamingStats().queues.downloadedBytes, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('queued pipeline priorities refresh and stale jobs are cancellable', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    globalThis.fetch = async () => {
        fetchCount++;
        return new Response(new Uint8Array([1]));
    };

    try {
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            prepare: async () => {},
            hasEntity: () => true,
            hide: () => {},
            show: () => {},
            unload: () => {}
        });
        manager.maxDownloadedBytes = 0;
        manager.staleRequestFrames = 1;
        const node = makeNode('stale', 10);

        const loading = manager.loadContent(node, 1);
        await new Promise(resolve => setTimeout(resolve, 0));
        assert.equal(manager._capacityWaiters.length, 1);

        manager._refreshPipelinePriority(node, 50);
        assert.equal(manager._capacityWaiters[0].priority, 50);

        manager._frameNumber = 2;
        manager._cancelStalePipelineJobs(new Set());
        await loading;

        assert.equal(fetchCount, 0);
        assert.equal(manager.getLoadStage(node), null);
        assert.equal(node.__contentLoaded, false);
        const stats = manager.getStreamingStats();
        assert.equal(stats.counters.staleDropped, 1);
        assert.equal(stats.counters.cancelled, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('bulk priority refresh handles 2000 jobs with one sort per queue and one renderer update', () => {
    const source = {
        getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
        resolveRequest: url => ({ url })
    };
    let bulkUpdates = 0;
    let singleUpdates = 0;
    const manager = new TileManager(source, {
        updatePriorities(priorityByNode) {
            bulkUpdates++;
            assert.equal(priorityByNode.size, 2000);
        },
        updatePriority() {
            singleUpdates++;
        }
    });
    const nodes = Array.from({ length: 2000 }, (_, index) => makeNode(`priority-${index}`, 10));
    const updates = nodes.map((node, index) => ({
        node,
        priority: 2000 - index,
        requestClass: 'visible'
    }));
    for (const node of nodes) {
        manager._pipelineJobs.set(node, {
            node,
            priority: 0,
            requestClass: 'coverage',
            lastWantedFrame: 0
        });
        manager._requestQueue.push({ node, priority: 0 });
        manager._decodeQueue.push({ node, priority: 0 });
        manager._capacityWaiters.push({ node, priority: 0 });
    }

    let sortCalls = 0;
    for (const queue of [manager._requestQueue, manager._decodeQueue, manager._capacityWaiters]) {
        const nativeSort = queue.sort;
        queue.sort = function (...args) {
            sortCalls++;
            return nativeSort.apply(this, args);
        };
    }

    const started = performance.now();
    manager._refreshPipelinePriorities(updates);
    const elapsed = performance.now() - started;

    assert.equal(sortCalls, 3);
    assert.equal(bulkUpdates, 1);
    assert.equal(singleUpdates, 0);
    assert.ok(elapsed < 250, `bulk refresh took ${elapsed.toFixed(1)}ms`);
    assert.equal(manager._requestQueue[0].priority, 2000);
    assert.equal(manager._requestQueue.at(-1).priority, 1);
});

test('selection performs one bulk priority refresh for a 2000-request frame', () => {
    const source = {
        getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
        resolveRequest: url => ({ url })
    };
    const manager = new TileManager(source, {
        hide: () => {},
        show: () => {},
        unload: () => {}
    });
    const requested = Array.from({ length: 2000 }, (_, index) => {
        const node = makeNode(`frame-priority-${index}`, 10);
        node.__contentLoaded = true;
        return { node, priority: 2000 - index, requestClass: 'visible' };
    });
    manager._select = () => ({ selected: new Set(), requested, immune: new Set() });
    let refreshCalls = 0;
    manager._refreshPipelinePriorities = updates => {
        refreshCalls++;
        assert.equal(updates, requested);
    };

    manager._updateCoreSelection([0, 0, 0], Math.PI / 3, 1000, null);

    assert.equal(refreshCalls, 1);
});

test('hard pipeline job cap prevents small-tile queues from growing without bound', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([1]));
    try {
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            prepare: async () => {},
            hasEntity: () => true,
            hide: () => {},
            show: () => {},
            unload: () => {}
        });
        manager.maxPipelineJobs = 2;
        manager.maxDownloadedBytes = 0;
        const a = makeNode('cap-a', 10);
        const b = makeNode('cap-b', 10);
        const c = makeNode('cap-c', 10);

        const loadA = manager.loadContent(a, 1, 'visible');
        const loadB = manager.loadContent(b, 1, 'visible');
        await new Promise(resolve => setTimeout(resolve, 0));
        const admittedC = await manager.loadContent(c, 1, 'visible');

        assert.equal(admittedC, false);
        assert.equal(manager._pipelineJobs.size, 2);
        assert.equal(c.__contentLoaded, undefined);
        assert.equal(manager.getStreamingStats().queues.pipelineJobLimit, 2);

        manager.unloadContent(a);
        manager.unloadContent(b);
        await Promise.all([loadA, loadB]);
        assert.equal(manager._pipelineJobs.size, 0);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('a direction change drops stale speculative work before visible work', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([1]));
    try {
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            prepare: async () => {},
            hasEntity: () => true,
            hide: () => {},
            show: () => {},
            unload: () => {}
        });
        manager.maxDownloadedBytes = 0;
        manager.staleRequestFrames = 12;
        const speculative = makeNode('predicted-turn', 10);
        const visible = makeNode('visible-turn', 10);
        const speculativeLoad = manager.loadContent(speculative, -1, 'speculative');
        const visibleLoad = manager.loadContent(visible, 10, 'visible');
        await new Promise(resolve => setTimeout(resolve, 0));

        manager._frameNumber = 2;
        manager._cancelStalePipelineJobs(new Set());
        await speculativeLoad;
        assert.equal(speculative.__contentLoaded, false);
        assert.equal(visible.__contentLoaded, true, 'visible work retains the normal stale grace period');

        manager._frameNumber = 12;
        manager._cancelStalePipelineJobs(new Set());
        await visibleLoad;
        const stats = manager.getStreamingStats();
        assert.equal(stats.counters.staleDropped, 2);
        assert.equal(stats.counters.cancelled, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('higher decode concurrency increases synthetic desktop decode throughput', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(new Uint8Array([1, 2, 3, 4]));
    const runBatch = async (concurrency) => {
        const active = new Set();
        const source = {
            getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
            resolveRequest: url => ({ url })
        };
        const manager = new TileManager(source, {
            decode: async (_node, bytes) => {
                await new Promise(resolve => setTimeout(resolve, 10));
                return bytes;
            },
            prepare: async node => active.add(node),
            hasEntity: node => active.has(node),
            hide: () => {},
            show: () => {},
            unload: node => active.delete(node)
        });
        manager.byteCache = new TileCache({ persistent: false });
        manager.maxConcurrentRequests = 32;
        manager.maxConcurrentDecodes = concurrency;
        const nodes = Array.from({ length: 16 }, (_, index) => makeNode(`scale-${concurrency}-${index}`, 10));
        const started = performance.now();
        await Promise.all(nodes.map(node => manager.loadContent(node, 1)));
        return performance.now() - started;
    };
    try {
        const serialMs = await runBatch(1);
        const parallelMs = await runBatch(8);
        assert.ok(parallelMs < serialMs * 0.6, `expected ${parallelMs}ms to beat ${serialMs}ms`);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
