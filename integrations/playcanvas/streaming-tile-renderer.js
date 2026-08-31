// Terratile-owned PlayCanvas streaming renderer.
//
// The engine-neutral TileManager owns selection, byte requests, cancellation,
// decode concurrency and render-readiness. This integration owns everything
// that is specific to PlayCanvas: worker configuration, pc.Asset decoding,
// frame-budgeted entity/material/texture preparation, dither materials and a
// synchronously-restorable resident entity cache.

(function () {
    if (typeof terratile === 'undefined') {
        throw new Error('streaming-tile-renderer: terratile is not loaded');
    }
    if (typeof pc === 'undefined') {
        throw new Error('streaming-tile-renderer: PlayCanvas is not loaded');
    }

    const MB = 1024 * 1024;
    const LONG_TASK_MS = 50;
    const DEFAULT_DRACO = {
        jsUrl: 'lib/draco.wasm.js',
        wasmUrl: 'lib/draco.wasm.wasm'
    };
    const DEFAULT_BASIS = {
        glueUrl: 'https://cdn.jsdelivr.net/gh/BinomialLLC/basis_universal/webgl/transcoder/build/basis_transcoder.js',
        wasmUrl: 'https://cdn.jsdelivr.net/gh/BinomialLLC/basis_universal/webgl/transcoder/build/basis_transcoder.wasm'
    };

    const workerState = {
        initialized: false,
        dracoWorkers: 0,
        basisWorkers: 0,
        profile: 'uninitialized'
    };

    function now() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
    }

    function clamp(value, min, max) {
        return Math.max(min, Math.min(max, value));
    }

    function abortError() {
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return error;
    }

    function isAbort(signal) {
        return signal?.aborted === true;
    }

    function nodeDepth(node) {
        let depth = 0;
        for (let parent = node?.__parent; parent; parent = parent.__parent) depth++;
        return depth;
    }

    function tileCenter(node) {
        const box = node?.boundingVolume?.box;
        if (!box) return null;
        return [box[0], box[2], -box[1]];
    }

    function collectRenderComponents(entity) {
        if (!entity) return [];
        if (typeof entity.findComponents === 'function') return entity.findComponents('render');
        const result = [];
        const visit = (current) => {
            if (current.render) result.push(current.render);
            for (const child of current.children ?? []) visit(child);
        };
        visit(entity);
        return result;
    }

    function collectMeshInstances(entity) {
        const result = [];
        for (const component of collectRenderComponents(entity)) {
            for (const meshInstance of component.meshInstances ?? []) result.push(meshInstance);
        }
        return result;
    }

    function selectWorkerProfile(options = {}) {
        const hardwareConcurrency = Math.max(1, Number(
            options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 4
        ) || 4);
        const userAgent = String(globalThis.navigator?.userAgent ?? '');
        const mobile = options.mobile ?? /Android|iPhone|iPad|Mobile/i.test(userAgent);
        const standaloneXr = options.standaloneXr ?? (mobile && /OculusBrowser|Quest/i.test(userAgent));
        let profile = options.profile ?? 'auto';
        if (profile === 'auto') profile = standaloneXr ? 'xr' : mobile ? 'mobile' : 'desktop';

        let dracoWorkers;
        let basisWorkers;
        let targetFrameMs;
        if (profile === 'xr') {
            dracoWorkers = clamp(Math.floor(hardwareConcurrency * 0.38), 2, 3);
            basisWorkers = clamp(Math.floor(hardwareConcurrency * 0.25), 1, 2);
            targetFrameMs = 1000 / 72;
        } else if (profile === 'mobile') {
            dracoWorkers = clamp(Math.floor(hardwareConcurrency * 0.42), 2, 4);
            basisWorkers = clamp(Math.floor(hardwareConcurrency * 0.22), 1, 2);
            targetFrameMs = 20;
        } else {
            // Aggressive desktop profile: use roughly three quarters of the
            // reported logical CPUs for decode workers. A 24-thread desktop
            // resolves to 12 Draco + 6 Basis; a browser reporting 16 resolves
            // to 8 + 4. The remaining quarter stays available to PlayCanvas,
            // the compositor, graphics driver and operating system.
            dracoWorkers = clamp(Math.floor(hardwareConcurrency * 0.5), 2, 12);
            basisWorkers = clamp(Math.floor(hardwareConcurrency * 0.25), 1, 6);
            targetFrameMs = 1000 / 60;
        }

        dracoWorkers = Math.max(0, Math.floor(options.dracoWorkers ?? dracoWorkers));
        basisWorkers = Math.max(0, Math.floor(options.basisWorkers ?? basisWorkers));
        return { profile, hardwareConcurrency, dracoWorkers, basisWorkers, targetFrameMs };
    }

    function initializeWorkers(options = {}) {
        if (workerState.initialized) return { ...workerState };
        const selected = selectWorkerProfile(options);
        const draco = { ...DEFAULT_DRACO, ...(options.draco ?? {}) };
        const basis = { ...DEFAULT_BASIS, ...(options.basis ?? {}) };

        if (selected.dracoWorkers > 0 && typeof pc.dracoInitialize === 'function') {
            pc.dracoInitialize({ ...draco, numWorkers: selected.dracoWorkers });
            workerState.dracoWorkers = selected.dracoWorkers;
        } else if (pc.WasmModule && typeof pc.WasmModule.setConfig === 'function') {
            pc.WasmModule.setConfig('DracoDecoderModule', {
                glueUrl: draco.jsUrl,
                wasmUrl: draco.wasmUrl,
                fallbackUrl: draco.fallbackUrl ?? draco.jsUrl
            });
        }

        if (selected.basisWorkers > 0 && typeof pc.basisInitialize === 'function') {
            pc.basisInitialize({ ...basis, numWorkers: selected.basisWorkers, lazyInit: false });
            workerState.basisWorkers = selected.basisWorkers;
        }

        workerState.initialized = true;
        workerState.profile = selected.profile;
        return { ...workerState, hardwareConcurrency: selected.hardwareConcurrency, targetFrameMs: selected.targetFrameMs };
    }

    function selectResidentProfile(options = {}) {
        const hardwareConcurrency = Math.max(1, Number(
            options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 4
        ) || 4);
        const deviceMemory = Math.max(0, Number(
            options.deviceMemory ?? globalThis.navigator?.deviceMemory ?? 0
        ) || 0);
        const profile = options.profile ?? 'desktop';

        if (profile === 'xr') {
            return {
                profile,
                hardwareConcurrency,
                deviceMemory,
                maxResidentTiles: 180,
                maxResidentSourceBytes: 256 * MB,
                maxResidentGpuBytes: 640 * MB
            };
        }
        if (profile === 'mobile') {
            const strong = deviceMemory >= 8 || hardwareConcurrency >= 12;
            return {
                profile,
                hardwareConcurrency,
                deviceMemory,
                maxResidentTiles: strong ? 360 : 240,
                maxResidentSourceBytes: (strong ? 512 : 320) * MB,
                maxResidentGpuBytes: (strong ? 1280 : 896) * MB
            };
        }

        const highEnd = deviceMemory >= 8 && hardwareConcurrency >= 16;
        const workstation = deviceMemory >= 16 || hardwareConcurrency >= 24;
        return {
            profile,
            hardwareConcurrency,
            deviceMemory,
            maxResidentTiles: workstation ? 1200 : highEnd ? 800 : 500,
            maxResidentSourceBytes: (workstation ? 1536 : highEnd ? 1024 : 640) * MB,
            maxResidentGpuBytes: (workstation ? 3072 : highEnd ? 2048 : 1536) * MB
        };
    }

    class AdaptiveStreamingController {
        constructor(renderer, options = {}) {
            this.renderer = renderer;
            this.enabled = options !== false && options.enabled !== false;
            this.options = typeof options === 'object' ? options : {};
            this.manager = null;
            this.frame = 0;
            this.sampleFrames = Math.max(10, this.options.sampleFrames ?? 30);
            this.lastLongTasks = 0;
            this.healthySamples = 0;
            this.memoryPressure = false;
            this.residentScale = 1;
            this.state = { enabled: this.enabled, reason: 'initializing' };
            this._onMemoryPressure = () => {
                this.memoryPressure = true;
            };
            globalThis.addEventListener?.('memorypressure', this._onMemoryPressure);
        }

        attach(manager) {
            this.manager = manager;
            const decodeMax = Math.max(1, Number(this.options.decodeMax ?? manager.maxConcurrentDecodes));
            this.limits = {
                networkMin: Math.max(1, Number(this.options.networkMin ?? Math.max(16, Math.floor(manager.maxConcurrentRequests / 2)))),
                networkMax: Math.max(1, Number(this.options.networkMax ?? manager.maxConcurrentRequests)),
                decodeMin: Math.max(1, Number(this.options.decodeMin ?? Math.ceil(decodeMax * 0.5))),
                decodeMax,
                prepareMin: Math.max(0.25, Number(this.options.prepareMin ?? 2)),
                prepareMax: Math.max(0.25, Number(this.options.prepareMax ?? this.renderer.maxPrepareBudgetMs)),
                speculativeMin: Math.max(0, Number(this.options.speculativeMin ?? 4)),
                speculativeMax: Math.max(0, Number(this.options.speculativeMax ?? 24)),
                lookAheadMin: Math.max(0, Number(this.options.lookAheadMin ?? 0.75)),
                lookAheadMax: Math.max(0, Number(this.options.lookAheadMax ?? 3.5))
            };
            if (this.limits.networkMin > this.limits.networkMax) this.limits.networkMin = this.limits.networkMax;
            if (this.limits.decodeMin > this.limits.decodeMax) this.limits.decodeMin = this.limits.decodeMax;
            manager.maxConcurrentRequests = clamp(manager.maxConcurrentRequests,
                this.limits.networkMin, this.limits.networkMax);
            manager.maxConcurrentDecodes = clamp(manager.maxConcurrentDecodes,
                this.limits.decodeMin, this.limits.decodeMax);
            this.state = { enabled: this.enabled, reason: this.enabled ? 'attached' : 'disabled' };
        }

        tick() {
            if (!this.enabled || !this.manager || (++this.frame % this.sampleFrames) !== 0) return;
            const stats = this.manager.getStreamingStats();
            const queues = stats.queues ?? {};
            const rendererStats = stats.renderer ?? {};
            const rendererQueues = rendererStats.queues ?? {};
            const counters = rendererStats.counters ?? {};
            const frameCost = Number(rendererQueues.recentFrameCostMs) || 0;
            const targetFrame = Number(rendererQueues.targetFrameMs) || this.renderer.targetFrameMs;
            const frameRatio = targetFrame > 0 ? frameCost / targetFrame : 1;
            const longTasks = Number(counters.longTasks) || 0;
            const newLongTask = longTasks > this.lastLongTasks;
            this.lastLongTasks = longTasks;
            const overloaded = newLongTask || frameRatio > 1.12;
            const underloaded = frameRatio > 0 && frameRatio < 0.82;
            const cameraSpeed = Number(rendererQueues.cameraSpeed) || 0;

            if (overloaded) {
                this.manager.maxConcurrentDecodes = Math.max(this.limits.decodeMin,
                    this.manager.maxConcurrentDecodes - (newLongTask ? 2 : 1));
                this.renderer.maxPrepareBudgetMs = Math.max(this.limits.prepareMin,
                    this.renderer.maxPrepareBudgetMs * 0.82);
                this.manager.maxSpeculativeRequestsPerFrame = Math.max(this.limits.speculativeMin,
                    this.manager.maxSpeculativeRequestsPerFrame - 2);
                this.manager.predictiveLookAheadSeconds = Math.max(this.limits.lookAheadMin,
                    this.manager.predictiveLookAheadSeconds - 0.2);
                this.manager.maxConcurrentRequests = Math.max(this.limits.networkMin,
                    this.manager.maxConcurrentRequests - 8);
                this.healthySamples = 0;
                this.state.reason = newLongTask ? 'long-task-backoff' : 'frame-pressure-backoff';
            } else {
                const decodeBacklog = (Number(queues.queuedDecode) || 0) > 0 ||
                    (Number(queues.downloadedBytes) || 0) > 8 * MB;
                if (decodeBacklog && this.manager.maxConcurrentDecodes < this.limits.decodeMax) {
                    this.manager.maxConcurrentDecodes++;
                }
                if ((Number(queues.queuedPrepare) || 0) > 0 && frameRatio < 0.96) {
                    this.renderer.maxPrepareBudgetMs = Math.min(this.limits.prepareMax,
                        this.renderer.maxPrepareBudgetMs + 0.5);
                }
                if ((Number(queues.queuedNetwork) || 0) > 0 &&
                    (Number(queues.downloadedBytes) || 0) < this.manager.maxDownloadedBytes * 0.65) {
                    this.manager.maxConcurrentRequests = Math.min(this.limits.networkMax,
                        this.manager.maxConcurrentRequests + 8);
                }
                if (underloaded && cameraSpeed > 5) {
                    this.manager.maxSpeculativeRequestsPerFrame = Math.min(this.limits.speculativeMax,
                        this.manager.maxSpeculativeRequestsPerFrame + 1);
                    this.manager.predictiveLookAheadSeconds = Math.min(this.limits.lookAheadMax,
                        this.manager.predictiveLookAheadSeconds + 0.1);
                }
                this.healthySamples = underloaded ? this.healthySamples + 1 : 0;
                this.state.reason = decodeBacklog ? 'decode-catchup' : underloaded ? 'headroom-growth' : 'steady';
            }

            this._adaptResidentCache(frameRatio);
            this.state = {
                ...this.state,
                enabled: true,
                frameRatio,
                network: this.manager.maxConcurrentRequests,
                decodes: this.manager.maxConcurrentDecodes,
                prepareBudgetMs: this.renderer.maxPrepareBudgetMs,
                speculativePerFrame: this.manager.maxSpeculativeRequestsPerFrame,
                lookAheadSeconds: this.manager.predictiveLookAheadSeconds,
                residentScale: this.residentScale
            };
        }

        _adaptResidentCache(frameRatio) {
            const memory = globalThis.performance?.memory;
            const heapRatio = memory?.jsHeapSizeLimit > 0 ?
                memory.usedJSHeapSize / memory.jsHeapSizeLimit : 0;
            const pressured = this.memoryPressure || heapRatio > 0.82;
            if (pressured) {
                this.residentScale = Math.max(0.35, this.residentScale * 0.75);
                this.memoryPressure = false;
                this.healthySamples = 0;
                this.state.reason = 'memory-pressure-eviction';
            } else if (heapRatio > 0 && heapRatio < 0.62 && frameRatio < 0.95 && this.healthySamples >= 10) {
                this.residentScale = Math.min(1, this.residentScale + 0.05);
                this.healthySamples = 0;
            }
            const base = this.renderer._residentBaseLimits;
            this.renderer.maxResidentTiles = Math.max(32, Math.floor(base.tiles * this.residentScale));
            this.renderer.maxResidentSourceBytes = Math.max(64 * MB, Math.floor(base.sourceBytes * this.residentScale));
            this.renderer.maxResidentGpuBytes = Math.max(256 * MB, Math.floor(base.gpuBytes * this.residentScale));
            if (pressured) this.renderer._evictResidents();
        }

        snapshot() {
            return { ...this.state, limits: this.limits ? { ...this.limits } : null };
        }

        dispose() {
            globalThis.removeEventListener?.('memorypressure', this._onMemoryPressure);
        }
    }

    class GlbWorkerPool {
        constructor(size) {
            this.size = Math.max(1, Math.floor(size));
            this.queue = [];
            this.workers = [];
            this.jobs = new Map();
            this.sequence = 0;
            this.workerUrl = null;
            this.available = typeof Worker !== 'undefined' && typeof Blob !== 'undefined' &&
                typeof URL?.createObjectURL === 'function' && typeof terratile.parseDerivedGlb === 'function';
            if (this.available) this._initialize();
        }

        _initialize() {
            const parser = terratile.parseDerivedGlb.toString();
            const collect = terratile.collectDerivedTransferables.toString();
            const source = `
                const parseDerivedGlb = ${parser};
                const collectDerivedTransferables = ${collect};
                self.onmessage = event => {
                    const { id, buffer } = event.data;
                    try {
                        const result = parseDerivedGlb(buffer);
                        result.raw = buffer;
                        const transfer = collectDerivedTransferables(result);
                        transfer.push(buffer);
                        self.postMessage({ id, result }, transfer);
                    } catch (error) {
                        self.postMessage({ id, result: {
                            supported: false,
                            reason: error?.message || String(error),
                            raw: buffer
                        } }, [buffer]);
                    }
                };
            `;
            this.workerUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            for (let index = 0; index < this.size; index++) {
                const worker = new Worker(this.workerUrl);
                const slot = { worker, busy: false, jobId: null };
                worker.onmessage = event => this._complete(slot, event.data);
                worker.onerror = error => this._fail(slot, error);
                this.workers.push(slot);
            }
        }

        parse(buffer, signal = null) {
            if (!this.available) {
                if (isAbort(signal)) return Promise.reject(abortError());
                return Promise.resolve().then(() => ({ ...terratile.parseDerivedGlb(buffer), raw: buffer }));
            }
            return new Promise((resolve, reject) => {
                const job = {
                    id: ++this.sequence,
                    buffer,
                    signal,
                    resolve,
                    reject,
                    active: false,
                    onAbort: null
                };
                if (signal) {
                    job.onAbort = () => {
                        if (!job.active) {
                            const index = this.queue.indexOf(job);
                            if (index >= 0) this.queue.splice(index, 1);
                            reject(abortError());
                        }
                    };
                    if (signal.aborted) {
                        reject(abortError());
                        return;
                    }
                    signal.addEventListener('abort', job.onAbort, { once: true });
                }
                this.queue.push(job);
                this._dispatch();
            });
        }

        _dispatch() {
            for (const slot of this.workers) {
                if (slot.busy || this.queue.length === 0) continue;
                const job = this.queue.shift();
                if (job.signal?.aborted) {
                    job.reject(abortError());
                    continue;
                }
                job.active = true;
                slot.busy = true;
                slot.jobId = job.id;
                this.jobs.set(job.id, job);
                slot.worker.postMessage({ id: job.id, buffer: job.buffer }, [job.buffer]);
                job.buffer = null;
            }
        }

        _complete(slot, message) {
            const job = this.jobs.get(message.id);
            this.jobs.delete(message.id);
            slot.busy = false;
            slot.jobId = null;
            if (job?.onAbort) job.signal.removeEventListener('abort', job.onAbort);
            if (job) {
                if (job.signal?.aborted) job.reject(abortError());
                else job.resolve(message.result);
            }
            this._dispatch();
        }

        _fail(slot, error) {
            const job = this.jobs.get(slot.jobId);
            this.jobs.delete(slot.jobId);
            slot.busy = false;
            slot.jobId = null;
            if (job?.onAbort) job.signal.removeEventListener('abort', job.onAbort);
            job?.reject(error instanceof Error ? error : new Error(String(error?.message ?? error)));
            this._dispatch();
        }

        dispose() {
            for (const job of this.queue) job.reject(abortError());
            this.queue.length = 0;
            for (const job of this.jobs.values()) job.reject(abortError());
            this.jobs.clear();
            for (const slot of this.workers) slot.worker.terminate();
            this.workers.length = 0;
            if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
            this.workerUrl = null;
        }
    }

    class TimingAccumulator {
        constructor(sampleLimit = 256) {
            this.sampleLimit = sampleLimit;
            this.metrics = new Map();
        }

        record(name, value) {
            if (!Number.isFinite(value) || value < 0) return;
            let metric = this.metrics.get(name);
            if (!metric) {
                metric = { count: 0, total: 0, max: 0, samples: [] };
                this.metrics.set(name, metric);
            }
            metric.count++;
            metric.total += value;
            metric.max = Math.max(metric.max, value);
            metric.samples.push(value);
            if (metric.samples.length > this.sampleLimit) metric.samples.shift();
        }

        snapshot() {
            const result = {};
            for (const [name, metric] of this.metrics) {
                const sorted = metric.samples.slice().sort((a, b) => a - b);
                const percentile = (fraction) => {
                    if (sorted.length === 0) return 0;
                    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
                };
                result[name] = {
                    count: metric.count,
                    average: metric.count ? metric.total / metric.count : 0,
                    max: metric.max,
                    p50: percentile(0.5),
                    p95: percentile(0.95),
                    p99: percentile(0.99)
                };
            }
            return result;
        }
    }

    class PreparationQueue {
        constructor(renderer, options = {}) {
            this.renderer = renderer;
            this.maxJobs = Math.max(1, options.maxJobs ?? 96);
            this.texturesPerStep = Math.max(1, options.texturesPerStep ?? 2);
            this.meshBuffersPerStep = Math.max(1, options.meshBuffersPerStep ?? 4);
            this.longTaskMs = Math.max(1, options.longTaskMs ?? LONG_TASK_MS);
            this.maxDeferralMs = Math.max(50, options.maxDeferralMs ?? 350);
            this._jobs = new Map();
            this._admission = [];
            this._sequence = 0;
            this._phaseCost = new Map();
        }

        enqueue(node, decoded, request) {
            if (this._jobs.has(node)) return this._jobs.get(node).promise;
            let resolve;
            let reject;
            const promise = new Promise((res, rej) => {
                resolve = res;
                reject = rej;
            });
            const job = {
                node,
                decoded,
                request,
                signal: request?.requestInit?.signal ?? null,
                priority: Number(request?.priority) || 0,
                dynamicPriority: 0,
                sequence: this._sequence++,
                phase: 'instantiate',
                entity: null,
                meshInstances: [],
                textures: [],
                textureIndex: 0,
                meshIndex: 0,
                enqueuedAt: now(),
                resolve,
                reject,
                promise,
                admitted: false,
                abortListener: null
            };
            if (job.signal) {
                job.abortListener = () => this.cancel(node, 'aborted');
                if (job.signal.aborted) {
                    this.renderer._disposeDecoded(decoded, null);
                    reject(abortError());
                    return promise;
                }
                job.signal.addEventListener('abort', job.abortListener, { once: true });
            }
            if (this._jobs.size < this.maxJobs) this._admit(job);
            else this._admission.push(job);
            return promise;
        }

        _admit(job) {
            job.admitted = true;
            this._jobs.set(job.node, job);
        }

        _admitWaiting() {
            this._admission.sort((a, b) => this._priority(b) - this._priority(a));
            while (this._jobs.size < this.maxJobs && this._admission.length > 0) {
                const job = this._admission.shift();
                if (isAbort(job.signal)) {
                    this._reject(job, abortError());
                    continue;
                }
                this._admit(job);
            }
        }

        updatePriority(node, priority) {
            const job = this._jobs.get(node) ?? this._admission.find(entry => entry.node === node);
            if (job) job.priority = Number(priority) || 0;
        }

        updatePriorities(priorityByNode) {
            for (const job of this._jobs.values()) {
                const priority = priorityByNode.get(job.node);
                if (priority !== undefined) job.priority = Number(priority) || 0;
            }
            for (const job of this._admission) {
                const priority = priorityByNode.get(job.node);
                if (priority !== undefined) job.priority = Number(priority) || 0;
            }
        }

        reprioritize(score) {
            for (const job of this._jobs.values()) job.dynamicPriority = score(job);
            for (const job of this._admission) job.dynamicPriority = score(job);
        }

        cancel(node, reason = 'cancelled') {
            const job = this._jobs.get(node);
            if (job) {
                this._jobs.delete(node);
                this.renderer._disposeDecoded(job.decoded, job.entity);
                this.renderer._increment(reason === 'stale' ? 'staleDropped' : 'cancelledPrepare');
                this._reject(job, abortError());
                this._admitWaiting();
                return true;
            }
            const index = this._admission.findIndex(entry => entry.node === node);
            if (index < 0) return false;
            const [waiting] = this._admission.splice(index, 1);
            this.renderer._disposeDecoded(waiting.decoded, waiting.entity);
            this.renderer._increment(reason === 'stale' ? 'staleDropped' : 'cancelledPrepare');
            this._reject(waiting, abortError());
            return true;
        }

        _priority(job) {
            return job.priority + job.dynamicPriority - job.sequence * 1e-9;
        }

        _next(predicate = null) {
            let best = null;
            let bestPriority = -Infinity;
            for (const job of this._jobs.values()) {
                if (predicate && !predicate(job)) continue;
                const priority = this._priority(job);
                if (priority > bestPriority) {
                    best = job;
                    bestPriority = priority;
                }
            }
            return best;
        }

        _estimatedPhaseCost(phase) {
            return this._phaseCost.get(phase) ?? (phase === 'instantiate' ? 1.5 : 0.4);
        }

        flush(budgetMs) {
            if (budgetMs <= 0 || this._jobs.size === 0) return 0;
            const started = now();
            const deadline = started + budgetMs;
            this._textureBudget = this.texturesPerStep;
            this._meshBufferBudget = this.meshBuffersPerStep;
            let steps = 0;
            while (this._jobs.size > 0) {
                const job = this._next((candidate) => {
                    if (candidate.phase === 'textures') return this._textureBudget > 0;
                    if (candidate.phase === 'meshes') return this._meshBufferBudget > 0;
                    return true;
                });
                if (!job) break;
                if (isAbort(job.signal)) {
                    this.cancel(job.node, 'aborted');
                    continue;
                }
                const remaining = deadline - now();
                const waitedTooLong = now() - job.enqueuedAt >= this.maxDeferralMs;
                if (remaining < this._estimatedPhaseCost(job.phase) && !waitedTooLong) break;
                this._runStep(job);
                steps++;
                if (now() >= deadline) break;
            }
            this.renderer._record('prepareQueueMs', now() - started);
            return steps;
        }

        _runStep(job) {
            const phase = job.phase;
            const started = now();
            try {
                if (phase === 'instantiate') this.renderer._instantiate(job);
                else if (phase === 'materials') this.renderer._prepareMaterials(job);
                else if (phase === 'hooks') this.renderer._runPrepareHooks(job);
                else if (phase === 'textures') {
                    this._textureBudget -= this.renderer._uploadTextures(job, this._textureBudget);
                } else if (phase === 'meshes') {
                    this._meshBufferBudget -= this.renderer._uploadMeshBuffers(job, this._meshBufferBudget);
                } else if (phase === 'finalize') this.renderer._finalize(job);
            } catch (error) {
                this._jobs.delete(job.node);
                this.renderer._disposeDecoded(job.decoded, job.entity);
                this._reject(job, error);
                this._admitWaiting();
                return;
            }
            const elapsed = now() - started;
            const previous = this._phaseCost.get(phase) ?? elapsed;
            this._phaseCost.set(phase, previous * 0.8 + elapsed * 0.2);
            this.renderer._record(`${phase}Ms`, elapsed);
            if (phase === 'textures') this.renderer._record('textureUploadMs', elapsed);
            if (elapsed >= this.longTaskMs) {
                this.renderer._increment('longTasks');
                this.renderer._record('longTaskMs', elapsed);
            }
            if (job.phase === 'complete') {
                this._jobs.delete(job.node);
                this._resolve(job);
                this._admitWaiting();
            }
        }

        _resolve(job) {
            if (job.abortListener) job.signal.removeEventListener('abort', job.abortListener);
            job.resolve();
        }

        _reject(job, error) {
            if (job.abortListener) job.signal.removeEventListener('abort', job.abortListener);
            job.reject(error);
        }

        clear() {
            for (const job of this._jobs.values()) {
                this.renderer._disposeDecoded(job.decoded, job.entity);
                this._reject(job, abortError());
            }
            for (const job of this._admission) {
                this.renderer._disposeDecoded(job.decoded, job.entity);
                this._reject(job, abortError());
            }
            this._jobs.clear();
            this._admission.length = 0;
        }

        get size() {
            return this._jobs.size;
        }

        get waiting() {
            return this._admission.length;
        }
    }

    class StreamingDebugDisplay {
        constructor(getStats, options = {}) {
            this.getStats = getStats;
            this.intervalMs = options.intervalMs ?? 500;
            this.element = document.createElement('pre');
            this.element.dataset.terratileDebug = 'streaming';
            Object.assign(this.element.style, {
                position: 'fixed',
                right: '8px',
                bottom: '8px',
                zIndex: '2147483647',
                margin: '0',
                padding: '8px',
                color: '#d7f7ff',
                background: 'rgba(0, 12, 18, 0.82)',
                font: '11px/1.35 monospace',
                pointerEvents: 'none',
                whiteSpace: 'pre'
            });
            (options.parent ?? document.body).appendChild(this.element);
            this.timer = setInterval(() => this.render(), this.intervalMs);
            this.render();
        }

        render() {
            const stats = this.getStats();
            const q = stats.queues ?? stats.renderer?.queues ?? {};
            const t = stats.timings ?? stats.renderer?.timings ?? {};
            this.element.textContent = [
                `network ${q.activeNetwork ?? 0}/${q.queuedNetwork ?? 0}`,
                `decode  ${q.activeDecode ?? 0}/${q.queuedDecode ?? 0}`,
                `prepare ${q.activePrepare ?? 0}/${q.queuedPrepare ?? 0}`,
                `resident ${q.residentCount ?? 0}  ${(q.residentSourceBytes ?? 0) / MB | 0} MB`,
                `download p95 ${(t.downloadMs?.p95 ?? 0).toFixed(1)} ms`,
                `decode   p95 ${(t.decodeMs?.p95 ?? 0).toFixed(1)} ms`,
                `inst     p95 ${(t.instantiateMs?.p95 ?? 0).toFixed(1)} ms`,
                `upload   p95 ${(t.textureUploadMs?.p95 ?? 0).toFixed(1)} ms`
            ].join('\n');
        }

        destroy() {
            clearInterval(this.timer);
            this.element.remove();
        }
    }

    function percentile(values, fraction) {
        if (values.length === 0) return 0;
        const sorted = values.slice().sort((a, b) => a - b);
        return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
    }

    function counterDelta(after, before, name) {
        return (after?.counters?.[name] ?? 0) - (before?.counters?.[name] ?? 0);
    }

    /**
     * Fly a PlayCanvas camera through fixed waypoints and return a detached
     * streaming report. Run the same path after changing worker overrides or
     * queue limits to compare decode throughput, long tasks and queue peaks.
     * @param {object} options - Benchmark options.
     * @param {object} options.app - PlayCanvas application.
     * @param {object} options.manager - Terratile TileManager.
     * @param {object} options.camera - PlayCanvas camera entity.
     * @param {Array<number[]|object>} options.waypoints - Camera positions.
     * @param {number} [options.durationMs] - Flight duration.
     * @param {number} [options.settleMs] - Post-flight sampling delay.
     * @param {boolean} [options.restoreCamera] - Restore original position.
     * @returns {Promise<object>} Detached benchmark report.
     */
    function runBenchmarkFlight(options) {
        const {
            app,
            manager,
            camera,
            waypoints,
            durationMs = 15_000,
            settleMs = 3_000,
            restoreCamera = true
        } = options;
        if (!app || !manager || !camera) throw new Error('Benchmark flight requires app, manager and camera');
        if (!Array.isArray(waypoints) || waypoints.length < 2) {
            throw new Error('Benchmark flight requires at least two [x,y,z] waypoints');
        }
        const points = waypoints.map((point) => {
            return Array.isArray(point) ? point : [point.x, point.y, point.z];
        });
        const original = camera.getPosition?.().clone?.() ?? camera.getPosition?.() ?? null;
        const before = manager.getStreamingStats();
        const frameTimes = [];
        const queuePeaks = {
            activeNetwork: 0,
            queuedNetwork: 0,
            activeDecode: 0,
            queuedDecode: 0,
            queuedPrepare: 0,
            downloadedBytes: 0,
            decodedBytes: 0
        };
        let elapsedMs = 0;

        return new Promise((resolve) => {
            const handlerRef = { current: null };
            const finish = () => {
                app.off('update', handlerRef.current);
                if (restoreCamera && original && camera.setPosition) camera.setPosition(original);
                setTimeout(() => {
                    const after = manager.getStreamingStats();
                    const seconds = Math.max(0.001, durationMs / 1000);
                    resolve({
                        durationMs,
                        settleMs,
                        workers: after.renderer?.workers ?? null,
                        frames: {
                            count: frameTimes.length,
                            averageMs: frameTimes.length ? frameTimes.reduce((sum, value) => sum + value, 0) / frameTimes.length : 0,
                            maxMs: frameTimes.length ? Math.max(...frameTimes) : 0,
                            p95Ms: percentile(frameTimes, 0.95),
                            p99Ms: percentile(frameTimes, 0.99)
                        },
                        throughput: {
                            completedTilesPerSecond: counterDelta(after, before, 'completed') / seconds,
                            networkMegabytesPerSecond: counterDelta(after, before, 'networkBytes') / seconds / MB,
                            cancelled: counterDelta(after, before, 'cancelled'),
                            staleDropped: counterDelta(after, before, 'staleDropped'),
                            longTasks: counterDelta(after.renderer, before.renderer, 'longTasks')
                        },
                        queuePeaks,
                        before,
                        after
                    });
                }, Math.max(0, settleMs));
            };

            const updateHandler = (dt) => {
                const frameMs = Math.max(0, Number(dt) * 1000);
                frameTimes.push(frameMs);
                elapsedMs += frameMs;
                const progress = clamp(elapsedMs / Math.max(1, durationMs), 0, 1);
                const segmentPosition = progress * (points.length - 1);
                const segment = Math.min(points.length - 2, Math.floor(segmentPosition));
                const local = segmentPosition - segment;
                const from = points[segment];
                const to = points[segment + 1];
                camera.setPosition(
                    from[0] + (to[0] - from[0]) * local,
                    from[1] + (to[1] - from[1]) * local,
                    from[2] + (to[2] - from[2]) * local
                );
                const stats = manager.getStreamingStats();
                for (const name of Object.keys(queuePeaks)) {
                    queuePeaks[name] = Math.max(queuePeaks[name], stats.queues?.[name] ?? 0);
                }
                if (progress >= 1) finish();
            };
            handlerRef.current = updateHandler;
            app.on('update', updateHandler);
        });
    }

    class TileRenderer {
        constructor(options = {}) {
            if (!options.app) throw new Error('TileRenderer requires options.app');
            if (!options.parent) throw new Error('TileRenderer requires options.parent');
            this.app = options.app;
            this.parent = options.parent;
            this.castShadows = options.castShadows ?? false;
            this.layerIds = options.layerIds ?? null;
            this.disableLighting = options.disableLighting ?? true;
            this.prewarmTextures = options.prewarmTextures ?? true;
            this.prewarmMeshes = options.prewarmMeshes ?? true;
            const workerSelection = selectWorkerProfile(options.workers ?? {});
            const residentProfile = selectResidentProfile({
                ...(options.residentCache ?? {}),
                profile: workerSelection.profile,
                hardwareConcurrency: workerSelection.hardwareConcurrency
            });
            this._residentProfile = residentProfile;
            this.maxResidentTiles = Math.max(0, options.maxResidentTiles ?? residentProfile.maxResidentTiles);
            this.maxResidentSourceBytes = Math.max(0,
                options.maxResidentSourceBytes ?? residentProfile.maxResidentSourceBytes);
            this.maxResidentGpuBytes = Math.max(0,
                options.maxResidentGpuBytes ?? residentProfile.maxResidentGpuBytes);
            this._residentBaseLimits = {
                tiles: this.maxResidentTiles,
                sourceBytes: this.maxResidentSourceBytes,
                gpuBytes: this.maxResidentGpuBytes
            };
            this.onEntityPrepared = options.onEntityPrepared ?? null;
            this.onEntityRestored = options.onEntityRestored ?? null;
            this.shouldShowEntity = options.shouldShowEntity ?? null;
            this.onTileChanged = options.onTileChanged ?? null;
            this.onEntityDestroyed = options.onEntityDestroyed ?? null;
            this.onApplyMixed = options.onApplyMixed ?? null;
            this.onClearMixed = options.onClearMixed ?? null;
            this.precompileMaterial = options.precompileMaterial ?? null;
            this._active = new Map();
            this._resident = new Map();
            this._protected = new Set();
            this._ditherMaterials = new WeakMap();
            this._configuredMaterials = new WeakSet();
            this._timings = new TimingAccumulator(options.sampleLimit ?? 256);
            this._counters = {
                decoded: 0,
                prepared: 0,
                restored: 0,
                residentEvictions: 0,
                cancelledPrepare: 0,
                staleDropped: 0,
                longTasks: 0,
                forcedProgressFrames: 0,
                derivedParsed: 0,
                derivedCacheHits: 0,
                derivedFallbacks: 0,
                derivedFailures: 0
            };
            this._activeDecodeJobs = 0;
            this._frame = {
                number: 0,
                cameraPos: null,
                cameraForward: null,
                velocity: [0, 0, 0],
                speed: 0,
                selected: new Set(),
                immune: new Set(),
                recentCostMs: 0,
                lastCameraPos: null,
                lastCameraTime: 0
            };

            const profile = workerSelection;
            this.workerProfile = initializeWorkers(options.workers ?? {});
            this.targetFrameMs = options.targetFrameMs ?? profile.targetFrameMs;
            this.frameReserveMs = Math.max(0, options.frameReserveMs ?? 1.5);
            const profilePrepareBudget = profile.profile === 'desktop' ? 14 : profile.profile === 'mobile' ? 8 : 5;
            this.maxPrepareBudgetMs = Math.max(0.25, options.maxPrepareBudgetMs ?? profilePrepareBudget);
            // A busy host application may consume the nominal frame budget
            // indefinitely (dynamic-entity boot is a common example). Once a
            // preparation job has aged past PreparationQueue.maxDeferralMs,
            // this tiny fair-share budget lets at least one phase advance per
            // frame instead of the old one-phase-per-20-frames starvation path.
            this.minPrepareProgressBudgetMs = Math.max(0.05,
                options.minPrepareProgressBudgetMs ?? 0.5);
            this.idleCatchupBudgetMs = Math.max(0.25, options.idleCatchupBudgetMs ?? 12);
            this.movingBudgetScale = clamp(options.movingBudgetScale ?? 0.45, 0.05, 1);
            this._queue = new PreparationQueue(this, options.prepareQueue);
            this._prepareSlotLimit = this._queue.maxJobs;
            this._prepareSlots = new Set();
            this._prepareSlotWaiters = [];
            this._frameStartTime = 0;
            this._schedulerFrame = 0;
            this._adaptive = new AdaptiveStreamingController(this, options.adaptiveTuning ?? {});
            this._derivedFastPath = options.derivedFastPath !== false &&
                typeof terratile.parseDerivedGlb === 'function' &&
                typeof terratile.DerivedResourceCache === 'function' &&
                typeof pc.Mesh === 'function' && typeof pc.Texture === 'function' &&
                typeof pc.StandardMaterial === 'function' && typeof pc.MeshInstance === 'function' &&
                typeof pc.Entity === 'function' && typeof globalThis.createImageBitmap === 'function';
            const parserWorkers = Math.max(1, Math.min(12,
                Number(options.parserWorkers) || Math.floor(profile.hardwareConcurrency * 0.5) || 1));
            this._glbWorkerPool = this._derivedFastPath ? new GlbWorkerPool(parserWorkers) : null;
            this._derivedCache = this._derivedFastPath ? new terratile.DerivedResourceCache({
                maxBytes: profile.profile === 'desktop' ? 2 * 1024 * MB : 512 * MB,
                maxMemoryBytes: profile.profile === 'desktop' ? 192 * MB : 64 * MB,
                ...(options.derivedCache ?? {})
            }) : null;
            this._onUpdate = () => {
                this._frameStartTime = now();
            };
            this._onFrameEnd = () => this._flushAtFrameEnd();
            this.app.on('update', this._onUpdate);
            this.app.on('frameend', this._onFrameEnd);
            this._debugDisplay = options.debugDisplay && typeof document !== 'undefined' ?
                new StreamingDebugDisplay(() => this.getStreamingStats(),
                    typeof options.debugDisplay === 'object' ? options.debugDisplay : {}) : null;
        }

        attachManager(manager) {
            this._manager = manager;
            this._adaptive.attach(manager);
        }

        async decode(node, bytes, request) {
            if (isAbort(request?.requestInit?.signal)) throw abortError();
            const url = request?.url ?? node?.content?.uri ?? 'tile.glb';
            const filename = new URL(url, globalThis.location?.href ?? 'http://localhost/').pathname.split('/').pop() || 'tile.glb';
            let workerFallback = null;
            if (this._derivedFastPath) {
                const cacheKey = await this._derivedCacheKey(bytes, request?.cacheKey ?? url);
                try {
                    const before = this._derivedCache.snapshot();
                    let derived = await this._derivedCache.get(cacheKey);
                    if (derived) {
                        const after = this._derivedCache.snapshot();
                        if (after.memoryHits > before.memoryHits || after.persistentHits > before.persistentHits) {
                            this._counters.derivedCacheHits++;
                        }
                    } else {
                        const parsed = await this._glbWorkerPool.parse(bytes, request?.requestInit?.signal);
                        workerFallback = parsed.raw ?? null;
                        if (parsed.supported && parsed.derived) {
                            derived = parsed.derived;
                            this._counters.derivedParsed++;
                            this._derivedCache.put(cacheKey, derived, derived.derivedByteLength).catch(() => {});
                        } else {
                            this._counters.derivedFallbacks++;
                        }
                    }
                    if (derived) {
                        const decoded = await this._decodeDerived(filename, url, derived);
                        if (isAbort(request?.requestInit?.signal)) {
                            this._disposeDecoded(decoded, null);
                            throw abortError();
                        }
                        this._counters.decoded++;
                        return decoded;
                    }
                } catch (error) {
                    if (error?.name === 'AbortError') throw error;
                    this._counters.derivedFailures++;
                    if ((!workerFallback || workerFallback.byteLength === 0) && bytes.byteLength === 0) throw error;
                }
            }
            const assetBytes = workerFallback ?? bytes;
            const asset = new pc.Asset(filename, 'container', { url, contents: assetBytes }, null, {
                image: {
                    postprocess: (_image, textureAsset) => {
                        if (textureAsset?.resource) {
                            textureAsset.resource.anisotropy = this.app.graphicsDevice.maxAnisotropy;
                        }
                    }
                }
            });
            asset.__sourceByteLength = assetBytes.byteLength;
            this._activeDecodeJobs++;
            let decoded;
            try {
                decoded = await new Promise((resolve, reject) => {
                    asset.once('load', () => resolve({ asset, sourceBytes: assetBytes.byteLength }));
                    asset.once('error', error => reject(error instanceof Error ? error : new Error(String(error))));
                    this.app.assets.add(asset);
                    this.app.assets.load(asset);
                });
            } finally {
                this._activeDecodeJobs = Math.max(0, this._activeDecodeJobs - 1);
            }
            if (isAbort(request?.requestInit?.signal)) {
                this._disposeDecoded(decoded, null);
                throw abortError();
            }
            this._counters.decoded++;
            return decoded;
        }

        async _derivedCacheKey(bytes, fallback) {
            if (globalThis.crypto?.subtle && bytes?.byteLength > 0) {
                const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
                const hash = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
                return `pc-glb-derived-v1:sha256:${hash}`;
            }
            return `pc-glb-derived-v1:url:${fallback}`;
        }

        async _decodeDerived(filename, url, derived) {
            const bitmaps = await Promise.all((derived.images ?? []).map((image) => {
                return globalThis.createImageBitmap(new Blob([image.bytes], { type: image.mimeType }));
            }));
            const resource = this._createDerivedResource(filename, derived, bitmaps);
            const asset = {
                name: filename,
                type: 'container',
                file: { url },
                resource,
                __sourceByteLength: derived.sourceByteLength,
                __terratileDerived: true,
                unload() {
                    resource.destroy();
                }
            };
            return { asset, sourceBytes: derived.sourceByteLength, derived: true };
        }

        _createDerivedResource(filename, derived, bitmaps) {
            const device = this.app.graphicsDevice;
            const textures = [];
            const materials = [];
            const meshes = [];
            const meshResources = [];
            let initialized = false;
            let destroyed = false;
            const addressMode = value => ({
                33071: pc.ADDRESS_CLAMP_TO_EDGE,
                33648: pc.ADDRESS_MIRRORED_REPEAT,
                10497: pc.ADDRESS_REPEAT
            })[value] ?? pc.ADDRESS_REPEAT;
            const filterMode = value => ({
                9728: pc.FILTER_NEAREST,
                9729: pc.FILTER_LINEAR,
                9984: pc.FILTER_NEAREST_MIPMAP_NEAREST,
                9985: pc.FILTER_LINEAR_MIPMAP_NEAREST,
                9986: pc.FILTER_NEAREST_MIPMAP_LINEAR,
                9987: pc.FILTER_LINEAR_MIPMAP_LINEAR
            })[value] ?? pc.FILTER_LINEAR;
            const createResources = () => {
                if (initialized) return;
                initialized = true;
                for (let index = 0; index < (derived.textures ?? []).length; index++) {
                    const descriptor = derived.textures[index];
                    const sampler = derived.samplers?.[descriptor.sampler] ?? {};
                    const bitmap = bitmaps[descriptor.source];
                    if (!bitmap) {
                        textures.push(null);
                        continue;
                    }
                    const minFilter = sampler.minFilter ?? 9987;
                    const texture = new pc.Texture(device, {
                        name: descriptor.name || `${filename}:texture:${index}`,
                        addressU: addressMode(sampler.wrapS),
                        addressV: addressMode(sampler.wrapT),
                        magFilter: filterMode(sampler.magFilter),
                        minFilter: filterMode(minFilter),
                        mipmaps: [9984, 9985, 9986, 9987].includes(minFilter)
                    });
                    texture.setSource(bitmap);
                    textures.push(texture);
                }
                const materialDescriptors = derived.materials?.length ? derived.materials : [{}];
                for (const descriptor of materialDescriptors) {
                    const material = new pc.StandardMaterial();
                    material.name = descriptor.name || `${filename}:material`;
                    const color = descriptor.baseColorFactor ?? [1, 1, 1, 1];
                    material.diffuse.set(color[0] ?? 1, color[1] ?? 1, color[2] ?? 1);
                    material.diffuse.gamma?.();
                    material.opacity = color[3] ?? 1;
                    const baseColorTexture = descriptor.baseColorTexture != null ?
                        textures[descriptor.baseColorTexture] ?? null : null;
                    if (descriptor.baseColorTexture != null) {
                        material.diffuseMap = baseColorTexture;
                        material.diffuseMapChannel = 'rgb';
                        material.opacityMap = baseColorTexture;
                        material.opacityMapChannel = 'a';
                    }
                    if (descriptor.unlit) {
                        // Match PlayCanvas's KHR_materials_unlit extension:
                        // unlit StandardMaterial renders through emissive, not
                        // diffuse, so leaving the imagery on diffuseMap produces
                        // black tiles despite a valid uploaded texture.
                        material.emissive.copy(material.diffuse);
                        material.emissiveMap = baseColorTexture;
                        material.emissiveMapChannel = 'rgb';
                        material.useLighting = false;
                        material.useSkybox = false;
                        material.diffuse.set(1, 1, 1);
                        material.diffuseMap = null;
                    } else {
                        material.useLighting = false;
                    }
                    material.cull = descriptor.doubleSided ? pc.CULLFACE_NONE : pc.CULLFACE_BACK;
                    if (descriptor.alphaMode === 'BLEND') {
                        material.blendType = pc.BLEND_NORMAL;
                        material.depthWrite = false;
                    } else if (descriptor.alphaMode === 'MASK') {
                        material.alphaTest = descriptor.alphaCutoff ?? 0.5;
                    }
                    material.update();
                    materials.push(material);
                }
                for (const meshDescriptor of derived.meshes ?? []) {
                    const primitiveMeshes = [];
                    for (const primitive of meshDescriptor.primitives ?? []) {
                        const mesh = new pc.Mesh(device);
                        mesh.setPositions(new Float32Array(primitive.positions.buffer), primitive.positions.components);
                        if (primitive.normals) {
                            mesh.setNormals(new Float32Array(primitive.normals.buffer), primitive.normals.components);
                        }
                        if (primitive.uvs) {
                            mesh.setUvs(0, new Float32Array(primitive.uvs.buffer), primitive.uvs.components);
                        }
                        if (primitive.colors && typeof mesh.setColors === 'function') {
                            mesh.setColors(new Float32Array(primitive.colors.buffer), primitive.colors.components);
                        }
                        if (primitive.indices) mesh.setIndices(new Uint32Array(primitive.indices.buffer));
                        mesh.update(pc.PRIMITIVE_TRIANGLES);
                        meshes.push(mesh);
                        primitiveMeshes.push({ mesh, material: materials[primitive.material ?? 0] ?? materials[0] });
                    }
                    meshResources.push(primitiveMeshes);
                }
            };
            const applyTransform = (entity, descriptor) => {
                if (descriptor.matrix && typeof pc.Mat4 === 'function') {
                    const matrix = new pc.Mat4();
                    matrix.data.set(descriptor.matrix);
                    const position = matrix.getTranslation();
                    const euler = matrix.getEulerAngles();
                    const scale = matrix.getScale();
                    entity.setLocalPosition(position.x, position.y, position.z);
                    entity.setLocalEulerAngles(euler.x, euler.y, euler.z);
                    entity.setLocalScale(scale.x, scale.y, scale.z);
                    return;
                }
                if (descriptor.translation) entity.setLocalPosition(...descriptor.translation);
                if (descriptor.rotation) entity.setLocalRotation(...descriptor.rotation);
                if (descriptor.scale) entity.setLocalScale(...descriptor.scale);
            };
            const resource = {
                textures: [],
                instantiateRenderEntity: (options = {}) => {
                    createResources();
                    const entities = (derived.nodes ?? []).map((descriptor, index) => {
                        const entity = new pc.Entity(descriptor.name || `${filename}:node:${index}`);
                        applyTransform(entity, descriptor);
                        if (descriptor.mesh != null) {
                            const entries = meshResources[descriptor.mesh] ?? [];
                            const meshInstances = entries.map(entry => new pc.MeshInstance(entry.mesh, entry.material));
                            entity.addComponent('render', {
                                meshInstances,
                                castShadows: options.castShadows ?? false
                            });
                        }
                        return entity;
                    });
                    for (let index = 0; index < entities.length; index++) {
                        for (const childIndex of derived.nodes[index]?.children ?? []) {
                            if (entities[childIndex]) entities[index].addChild(entities[childIndex]);
                        }
                    }
                    const root = new pc.Entity(filename);
                    const scene = derived.scenes?.[derived.scene] ?? derived.scenes?.[0];
                    const roots = scene?.nodes ?? entities.map((_entity, index) => index).filter((index) => {
                        return !(derived.nodes ?? []).some(node => node.children?.includes(index));
                    });
                    for (const index of roots) if (entities[index]) root.addChild(entities[index]);
                    resource.textures = textures.map(texture => ({ resource: texture }));
                    return root;
                },
                destroy() {
                    if (destroyed) return;
                    destroyed = true;
                    for (const mesh of meshes) mesh.destroy?.();
                    for (const material of materials) material.destroy?.();
                    for (const texture of textures) texture?.destroy?.();
                    for (const bitmap of bitmaps) bitmap?.close?.();
                    meshes.length = 0;
                    materials.length = 0;
                    textures.length = 0;
                }
            };
            return resource;
        }

        getDecodedByteLength(_node, decoded) {
            return decoded?.sourceBytes ?? decoded?.asset?.__sourceByteLength ?? 0;
        }

        prepare(node, decoded, request) {
            return this._queue.enqueue(node, decoded, request);
        }

        acquirePrepareSlot(node, priority = 0, signal = null) {
            if (this._prepareSlots.has(node)) return Promise.resolve();
            if (this._prepareSlots.size < this._prepareSlotLimit) {
                this._prepareSlots.add(node);
                return Promise.resolve();
            }
            return new Promise((resolve, reject) => {
                const entry = { node, priority, signal, resolve, reject, onAbort: null };
                if (signal) {
                    entry.onAbort = () => {
                        const index = this._prepareSlotWaiters.indexOf(entry);
                        if (index >= 0) this._prepareSlotWaiters.splice(index, 1);
                        reject(abortError());
                    };
                    if (signal.aborted) {
                        entry.onAbort();
                        return;
                    }
                    signal.addEventListener('abort', entry.onAbort, { once: true });
                }
                this._prepareSlotWaiters.push(entry);
                this._prepareSlotWaiters.sort((a, b) => b.priority - a.priority);
            });
        }

        releasePrepareSlot(node) {
            if (!this._prepareSlots.delete(node)) return;
            while (this._prepareSlotWaiters.length > 0) {
                const entry = this._prepareSlotWaiters.shift();
                if (entry.signal?.aborted) continue;
                if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
                this._prepareSlots.add(entry.node);
                entry.resolve();
                return;
            }
        }

        releaseDecoded() {
            // The decoded pc.Asset becomes part of the active/resident record.
            // It is released only when that record is evicted or dispose() runs.
        }

        _instantiate(job) {
            if (isAbort(job.signal)) throw abortError();
            const resource = job.decoded?.asset?.resource;
            if (!resource?.instantiateRenderEntity) throw new Error('Decoded tile has no container resource');
            const entity = resource.instantiateRenderEntity({ castShadows: this.castShadows });
            entity.enabled = false;
            this.parent.addChild(entity);
            job.entity = entity;
            job.meshInstances = collectMeshInstances(entity);
            job.textures = this._collectTextures(job.decoded.asset);
            job.phase = 'hooks';
        }

        _prepareMaterials(job) {
            const touched = new Set();
            for (const component of collectRenderComponents(job.entity)) {
                if (this.layerIds) component.layers = this.layerIds.slice();
                for (const meshInstance of component.meshInstances ?? []) {
                    const material = meshInstance.material;
                    if (!material || touched.has(material) || this._configuredMaterials.has(material)) continue;
                    touched.add(material);
                    let changed = false;
                    if (this.disableLighting && material.useLighting !== false) {
                        material.useLighting = false;
                        changed = true;
                    }
                    if (changed) material.update?.();
                    this._configuredMaterials.add(material);
                    // Build/cache the transition variant during preparation so
                    // the first handover does not clone and update materials.
                    const dither = this._getDitherMaterial(material);
                    this.precompileMaterial?.(material, dither, job.node, this.app);
                }
            }
            job.phase = this.prewarmTextures && job.textures.length > 0 ? 'textures' :
                this.prewarmMeshes && job.meshInstances.length > 0 ? 'meshes' : 'finalize';
        }

        _runPrepareHooks(job) {
            this.onEntityPrepared?.(job.entity, job.node, job.decoded.asset, this);
            // Scene hooks may replace materials (clipping, displacement,
            // stylized modes). Configure and cache transition variants for the
            // final materials, not the originals that were just replaced.
            job.entity.enabled = false;
            job.phase = 'materials';
        }

        _collectTextures(asset) {
            const result = [];
            for (const textureAsset of asset?.resource?.textures ?? []) {
                const texture = textureAsset?.resource;
                if (texture) result.push(texture);
            }
            return result;
        }

        _uploadTextures(job, limit) {
            const device = this.app.graphicsDevice;
            let count = 0;
            while (job.textureIndex < job.textures.length && count < limit) {
                const texture = job.textures[job.textureIndex++];
                if (!device.isWebGPU && typeof device.setTexture === 'function') {
                    try {
                        device.setTexture(texture, 0);
                    } catch {
                        // Upload is best effort on engine versions without this
                        // backend hook; first draw remains the fallback path.
                    }
                }
                count++;
            }
            if (job.textureIndex >= job.textures.length) {
                job.phase = this.prewarmMeshes && job.meshInstances.length > 0 ? 'meshes' : 'finalize';
            }
            return count;
        }

        _uploadMeshBuffers(job, limit) {
            const device = this.app.graphicsDevice;
            let count = 0;
            while (job.meshIndex < job.meshInstances.length && count < limit) {
                const mesh = job.meshInstances[job.meshIndex++]?.mesh;
                try {
                    const vertexBuffer = mesh?.vertexBuffer;
                    if (vertexBuffer && typeof device.setVertexBuffer === 'function') device.setVertexBuffer(vertexBuffer, 0);
                    const indexBuffer = mesh?.indexBuffer?.[0];
                    if (indexBuffer && typeof device.setIndexBuffer === 'function') device.setIndexBuffer(indexBuffer);
                } catch {
                    // PlayCanvas may not expose incremental upload hooks for a
                    // backend. Entity instantiation has still created buffers.
                }
                count++;
            }
            if (job.meshIndex >= job.meshInstances.length) job.phase = 'finalize';
            return count;
        }

        _finalize(job) {
            if (isAbort(job.signal)) throw abortError();
            const sourceBytes = job.decoded.sourceBytes ?? job.decoded.asset?.__sourceByteLength ?? 0;
            const record = {
                node: job.node,
                entity: job.entity,
                asset: job.decoded.asset,
                sourceBytes,
                gpuBytes: this._estimateGpuBytes(job),
                depth: nodeDepth(job.node),
                lastUsedFrame: this._frame.number,
                lastUsedTime: now(),
                distance: this._distanceToNode(job.node)
            };
            this._active.set(job.node, record);
            this._counters.prepared++;
            this._emit({ type: 'load', node: job.node, entity: job.entity, asset: record.asset });
            job.phase = 'complete';
        }

        _estimateGpuBytes(job) {
            let total = 0;
            for (const texture of job.textures) {
                const width = Number(texture.width) || 0;
                const height = Number(texture.height) || 0;
                total += width * height * 4 * (texture.mipmaps === false ? 1 : 4 / 3);
            }
            const buffers = new Set();
            for (const meshInstance of job.meshInstances) {
                const mesh = meshInstance?.mesh;
                if (mesh?.vertexBuffer) buffers.add(mesh.vertexBuffer);
                for (const indexBuffer of mesh?.indexBuffer ?? []) if (indexBuffer) buffers.add(indexBuffer);
            }
            for (const buffer of buffers) total += Number(buffer.numBytes ?? buffer.storage?.byteLength) || 0;
            return Math.ceil(total);
        }

        _getDitherMaterial(source) {
            if (!source?.clone) return null;
            let material = this._ditherMaterials.get(source);
            if (material) return material;
            material = source.clone();
            const chunks = material.shaderChunks?.glsl;
            if (!chunks?.get || !chunks?.set) return null;
            const declaration = chunks.get('litUserDeclarationPS') || '';
            const mainEnd = chunks.get('litUserMainEndPS') || '';
            chunks.set('litUserDeclarationPS', `${declaration}\nuniform float uTileFadeProgress;\nuniform float uTileFadeOut;\n`);
            chunks.set('litUserMainEndPS', `${mainEnd}\n{
    vec2 _tileFadePixel = floor(gl_FragCoord.xy);
    float _tileFadeThreshold = fract(52.9829189 * fract(dot(_tileFadePixel, vec2(0.06711056, 0.00583715))));
    bool _tileFadeKeep = uTileFadeOut > 0.5
        ? (_tileFadeThreshold >= uTileFadeProgress)
        : (_tileFadeThreshold < uTileFadeProgress);
    if (!_tileFadeKeep) discard;
}\n`);
            material.update();
            this._ditherMaterials.set(source, material);
            return material;
        }

        setFade(node, progress, direction) {
            const record = this._active.get(node) ?? this._resident.get(node);
            if (!record) return;
            const steady = direction === 'steady';
            const value = clamp(Number(progress) || 0, 0, 1);
            for (const meshInstance of collectMeshInstances(record.entity)) {
                const state = meshInstance.__terratileFade;
                if (steady) {
                    if (state && meshInstance.material === state.material) meshInstance.material = state.source;
                    meshInstance.deleteParameter?.('uTileFadeProgress');
                    meshInstance.deleteParameter?.('uTileFadeOut');
                    delete meshInstance.__terratileFade;
                    continue;
                }
                if (!state || meshInstance.material !== state.material) {
                    const source = meshInstance.material;
                    const material = this._getDitherMaterial(source);
                    if (!material) continue;
                    meshInstance.material = material;
                    meshInstance.__terratileFade = { source, material };
                }
                meshInstance.setParameter?.('uTileFadeProgress', value);
                meshInstance.setParameter?.('uTileFadeOut', direction === 'out' ? 1 : 0);
            }
        }

        setMixed(node, depth) {
            const record = this._active.get(node) ?? this._resident.get(node);
            if (record) this.onApplyMixed?.(record.entity, depth, node);
        }

        clearMixed(node) {
            const record = this._active.get(node) ?? this._resident.get(node);
            if (record) this.onClearMixed?.(record.entity, node);
        }

        setOpacity() {
            // Optional source-specific opacity remains an application hook.
        }

        hasEntity(node) {
            return this._active.has(node);
        }

        hasResident(node) {
            return this._resident.has(node);
        }

        restore(node) {
            const record = this._resident.get(node);
            if (!record) return false;
            this._resident.delete(node);
            record.entity.enabled = false;
            record.lastUsedFrame = this._frame.number;
            record.lastUsedTime = now();
            record.distance = this._distanceToNode(node);
            this._active.set(node, record);
            this._counters.restored++;
            this.onEntityRestored?.(record.entity, node, record.asset, this);
            this._emit({ type: 'restore', node, entity: record.entity, asset: record.asset });
            return true;
        }

        show(node) {
            if (!this._active.has(node)) this.restore(node);
            const record = this._active.get(node);
            if (!record) return;
            record.entity.enabled = this.shouldShowEntity ?
                this.shouldShowEntity(record.entity, node, record.asset, this) !== false : true;
            record.lastUsedFrame = this._frame.number;
            record.lastUsedTime = now();
            record.distance = this._distanceToNode(node);
            this._emit({ type: 'show', node, entity: record.entity, asset: record.asset });
        }

        hide(node) {
            const record = this._active.get(node);
            if (!record) return;
            this._emit({ type: 'hide', node, entity: record.entity, asset: record.asset });
            record.entity.enabled = false;
            record.lastUsedFrame = this._frame.number;
            record.lastUsedTime = now();
        }

        unload(node) {
            this._queue.cancel(node, 'stale');
            const record = this._active.get(node);
            if (!record) return;
            this._active.delete(node);
            this._emit({ type: 'unload', node, entity: record.entity, asset: record.asset });
            record.entity.enabled = false;
            record.lastUsedFrame = this._frame.number;
            record.lastUsedTime = now();
            record.distance = this._distanceToNode(node);
            if (this.maxResidentTiles > 0 && this.maxResidentSourceBytes > 0 && this.maxResidentGpuBytes > 0) {
                this._resident.set(node, record);
                this._evictResidents();
            } else {
                this._destroyRecord(record);
            }
        }

        discard(node) {
            this._queue.cancel(node, 'stale');
            const active = this._active.get(node);
            if (active) {
                this._active.delete(node);
                this._destroyRecord(active);
            }
            const resident = this._resident.get(node);
            if (resident) {
                this._resident.delete(node);
                this._destroyRecord(resident);
            }
        }

        updatePriority(node, priority) {
            this.updatePriorities(new Map([[node, priority]]));
        }

        updatePriorities(priorityByNode) {
            this._queue.updatePriorities(priorityByNode);
            let changed = false;
            for (const entry of this._prepareSlotWaiters) {
                const priority = priorityByNode.get(entry.node);
                if (priority === undefined) continue;
                entry.priority = Number(priority) || 0;
                changed = true;
            }
            if (changed) this._prepareSlotWaiters.sort((a, b) => b.priority - a.priority);
        }

        updateFrameContext(context = {}) {
            this._frame.number = context.frameNumber ?? this._frame.number + 1;
            this._frame.cameraPos = context.cameraPos ?? this._frame.cameraPos;
            this._frame.cameraForward = context.cameraForward ?? this._frame.cameraForward;
            this._frame.selected = context.selected ?? this._frame.selected;
            this._frame.immune = context.immune ?? this._frame.immune;
            const timestamp = now();
            if (context.cameraVelocity) {
                this._frame.velocity = context.cameraVelocity.slice();
                this._frame.speed = Math.hypot(...this._frame.velocity);
            } else if (this._frame.cameraPos && this._frame.lastCameraPos && this._frame.lastCameraTime > 0) {
                const dt = Math.max(1e-3, (timestamp - this._frame.lastCameraTime) / 1000);
                const velocity = this._frame.cameraPos.map(
                    (value, index) => (value - this._frame.lastCameraPos[index]) / dt
                );
                this._frame.velocity = velocity;
                this._frame.speed = Math.hypot(...velocity);
            }
            if (this._frame.cameraPos) this._frame.lastCameraPos = this._frame.cameraPos.slice();
            this._frame.lastCameraTime = timestamp;
            this._queue.reprioritize(job => this._dynamicPriority(job.node));
            for (const record of this._resident.values()) record.distance = this._distanceToNode(record.node);
        }

        setProtectedNodes(nodes) {
            this._protected = new Set(nodes ?? []);
        }

        _dynamicPriority(node) {
            let score = 0;
            if (this._frame.selected?.has(node)) score += 4;
            if (this._frame.immune?.has(node)) score += 6;
            const center = tileCenter(node);
            const camera = this._frame.cameraPos;
            if (!center || !camera) return score;
            const direction = center.map((value, index) => value - camera[index]);
            const distance = Math.max(1e-6, Math.hypot(...direction));
            const unit = direction.map(value => value / distance);
            const dot = (a, b) => {
                return a && b ? a[0] * b[0] + a[1] * b[1] + a[2] * b[2] : 0;
            };
            const forward = dot(unit, this._frame.cameraForward);
            const velocityLength = Math.max(1e-6, Math.hypot(...this._frame.velocity));
            const travel = dot(unit, this._frame.velocity.map(value => value / velocityLength));
            score += 2 * forward + 2.5 * travel;
            if (forward < -0.2) score -= 3;
            return score;
        }

        _distanceToNode(node) {
            const center = tileCenter(node);
            const camera = this._frame.cameraPos;
            if (!center || !camera) return 0;
            return Math.hypot(center[0] - camera[0], center[1] - camera[1], center[2] - camera[2]);
        }

        _flushAtFrameEnd() {
            this._schedulerFrame++;
            const observed = this._frameStartTime > 0 ? now() - this._frameStartTime : 0;
            if (observed > 0) {
                this._frame.recentCostMs = this._frame.recentCostMs > 0 ?
                    this._frame.recentCostMs * 0.85 + observed * 0.15 : observed;
            }
            const headroom = Math.max(0, this.targetFrameMs - this._frame.recentCostMs - this.frameReserveMs);
            const moving = this._frame.speed > 5;
            const fast = this._frame.speed > 50;
            let budget = moving ? headroom * this.movingBudgetScale :
                Math.max(headroom, Math.min(this.idleCatchupBudgetMs, headroom * 1.5));
            if (fast) budget *= 0.5;
            budget = clamp(budget, 0, this.maxPrepareBudgetMs);
            // Never deadlock preparation when the host itself permanently
            // exceeds the target frame cost. PreparationQueue's aging gate
            // still defers fresh jobs for maxDeferralMs; afterwards this
            // fair-share budget advances one bounded phase every frame.
            let forcedProgress = false;
            if (this._queue.size > 0 && budget < this.minPrepareProgressBudgetMs) {
                budget = Math.min(this.maxPrepareBudgetMs, this.minPrepareProgressBudgetMs);
                forcedProgress = true;
            }
            const steps = this._queue.flush(budget);
            if (forcedProgress && steps > 0) this._increment('forcedProgressFrames');
            this._adaptive.tick();
        }

        _evictResidents() {
            const totals = () => {
                let sourceBytes = 0;
                let gpuBytes = 0;
                for (const record of this._resident.values()) {
                    sourceBytes += record.sourceBytes;
                    gpuBytes += record.gpuBytes;
                }
                return { sourceBytes, gpuBytes };
            };
            let usage = totals();
            while (this._resident.size > this.maxResidentTiles ||
                usage.sourceBytes > this.maxResidentSourceBytes || usage.gpuBytes > this.maxResidentGpuBytes) {
                let victim = null;
                let victimScore = -Infinity;
                for (const record of this._resident.values()) {
                    if (this._protected.has(record.node) || this._frame.immune?.has(record.node)) continue;
                    const ageFrames = Math.max(0, this._frame.number - record.lastUsedFrame);
                    const distanceScore = Math.log2(2 + Math.max(0, record.distance));
                    const fallbackValue = record.depth * 0.35;
                    const score = ageFrames + distanceScore - fallbackValue;
                    if (score > victimScore) {
                        victim = record;
                        victimScore = score;
                    }
                }
                if (!victim) break;
                this._resident.delete(victim.node);
                this._destroyRecord(victim);
                this._counters.residentEvictions++;
                usage = totals();
            }
        }

        _destroyRecord(record) {
            this.onEntityDestroyed?.(record.entity, record.node, record.asset, this);
            record.entity?.destroy?.();
            record.asset?.unload?.();
            if (record.asset && !record.asset.__terratileDerived) this.app.assets.remove(record.asset);
        }

        _disposeDecoded(decoded, entity) {
            entity?.destroy?.();
            const asset = decoded?.asset;
            asset?.unload?.();
            if (asset && !asset.__terratileDerived) this.app.assets.remove(asset);
        }

        _emit(change) {
            this.onTileChanged?.(change);
        }

        _record(name, milliseconds) {
            this._timings.record(name, milliseconds);
        }

        _increment(name, amount = 1) {
            this._counters[name] = (this._counters[name] ?? 0) + amount;
        }

        getEntity(node) {
            return this._active.get(node)?.entity ?? this._resident.get(node)?.entity ?? null;
        }

        getActiveEntity(node) {
            return this._active.get(node)?.entity ?? null;
        }

        getActiveNodes() {
            return [...this._active.keys()];
        }

        forEachEntity(callback, { includeResident = true } = {}) {
            for (const record of this._active.values()) callback(record.entity, record.node, false);
            if (includeResident) {
                for (const record of this._resident.values()) callback(record.entity, record.node, true);
            }
        }

        getStreamingStats() {
            let residentSourceBytes = 0;
            let residentGpuBytes = 0;
            for (const record of this._resident.values()) {
                residentSourceBytes += record.sourceBytes;
                residentGpuBytes += record.gpuBytes;
            }
            return {
                profile: this.workerProfile.profile,
                workers: {
                    hardwareConcurrency: this.workerProfile.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency ?? 0,
                    draco: this.workerProfile.dracoWorkers,
                    basis: this.workerProfile.basisWorkers,
                    glbParsers: this._glbWorkerPool?.size ?? 0,
                    activeContainerDecodes: this._activeDecodeJobs
                },
                queues: {
                    activePrepare: this._prepareSlots.size,
                    queuedPrepare: this._prepareSlotWaiters.length + this._queue.waiting,
                    residentCount: this._resident.size,
                    residentSourceBytes,
                    residentGpuBytes,
                    recentFrameCostMs: this._frame.recentCostMs,
                    targetFrameMs: this.targetFrameMs,
                    cameraSpeed: this._frame.speed
                },
                counters: { ...this._counters },
                timings: this._timings.snapshot(),
                tuning: this._adaptive.snapshot(),
                residentProfile: { ...this._residentProfile },
                derivedCache: this._derivedCache?.snapshot?.() ?? null
            };
        }

        createDebugDisplay(options = {}) {
            this._debugDisplay?.destroy();
            const getStats = options.getStats ?? (() => this.getStreamingStats());
            this._debugDisplay = new StreamingDebugDisplay(getStats, options);
            return this._debugDisplay;
        }

        dispose() {
            this.app.off('update', this._onUpdate);
            this.app.off('frameend', this._onFrameEnd);
            this._adaptive.dispose();
            this._glbWorkerPool?.dispose();
            this._debugDisplay?.destroy();
            this._queue.clear();
            for (const entry of this._prepareSlotWaiters) {
                if (entry.onAbort) entry.signal.removeEventListener('abort', entry.onAbort);
                entry.reject(abortError());
            }
            this._prepareSlotWaiters.length = 0;
            this._prepareSlots.clear();
            for (const record of this._active.values()) this._destroyRecord(record);
            for (const record of this._resident.values()) this._destroyRecord(record);
            this._active.clear();
            this._resident.clear();
            this._protected.clear();
        }
    }

    terratile.playcanvas = terratile.playcanvas ?? {};
    terratile.playcanvas.TileRenderer = TileRenderer;
    terratile.playcanvas.StreamingDebugDisplay = StreamingDebugDisplay;
    terratile.playcanvas.selectWorkerProfile = selectWorkerProfile;
    terratile.playcanvas.selectResidentProfile = selectResidentProfile;
    terratile.playcanvas.initializeWorkers = initializeWorkers;
    terratile.playcanvas.runBenchmarkFlight = runBenchmarkFlight;
})();
