import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

import { DerivedResourceCache } from '../src/derived-cache.mjs';
import { collectDerivedTransferables, parseDerivedGlb } from '../src/glb-derived-parser.mjs';

const integrationSource = await readFile(
    new URL('../integrations/playcanvas/streaming-tile-renderer.js', import.meta.url),
    'utf8'
);

class Emitter {
    constructor() {
        this.listeners = new Map();
    }

    on(name, callback) {
        const list = this.listeners.get(name) ?? [];
        list.push(callback);
        this.listeners.set(name, list);
    }

    off(name, callback) {
        const list = this.listeners.get(name) ?? [];
        this.listeners.set(name, list.filter(entry => entry !== callback));
    }

    once(name, callback) {
        const wrapper = (...args) => {
            this.off(name, wrapper);
            callback(...args);
        };
        this.on(name, wrapper);
    }

    fire(name, ...args) {
        for (const callback of [...(this.listeners.get(name) ?? [])]) callback(...args);
    }
}

function createHarness({ hardwareConcurrency = 24, deviceMemory = 8, textureCount = 3, instantiateDelayMs = 0 } = {}) {
    const workerConfig = {};
    let materialCloneCount = 0;
    let instantiateCount = 0;
    let assetLoadCount = 0;
    let textureUploadCount = 0;
    let removedAssets = 0;

    class Material {
        constructor() {
            this.useLighting = true;
            this.shaderChunks = { glsl: new Map() };
            this.updateCount = 0;
            const color = () => ({
                value: [1, 1, 1],
                set(r, g, b) {
                    this.value = [r, g, b];
                    return this;
                },
                copy(other) {
                    this.value = other.value.slice();
                    return this;
                },
                gamma() {
                    return this;
                }
            });
            this.diffuse = color();
            this.emissive = color();
        }

        clone() {
            materialCloneCount++;
            const clone = new Material();
            clone.useLighting = this.useLighting;
            clone.shaderChunks.glsl = new Map(this.shaderChunks.glsl);
            return clone;
        }

        update() {
            this.updateCount++;
        }

        destroy() {
            this.destroyed = true;
        }
    }

    const sourceMaterial = new Material();
    const meshInstances = [0, 1].map(() => ({
        material: sourceMaterial,
        mesh: {
            vertexBuffer: { numBytes: 128 },
            indexBuffer: [{ numBytes: 64 }]
        },
        parameters: new Map(),
        setParameter(name, value) {
            this.parameters.set(name, value);
        },
        deleteParameter(name) {
            this.parameters.delete(name);
        }
    }));
    const entity = {
        enabled: true,
        destroyed: false,
        children: [],
        findComponents: () => [{ meshInstances, layers: [] }],
        destroy() {
            this.destroyed = true;
        }
    };

    class Asset extends Emitter {
        constructor(name, type, file) {
            super();
            this.name = name;
            this.type = type;
            this.file = file;
            this.unloaded = false;
            this.resource = null;
        }

        unload() {
            this.unloaded = true;
        }
    }

    class Mesh {
        constructor() {
            this.vertexBuffer = { numBytes: 0 };
            this.indexBuffer = [{ numBytes: 0 }];
        }

        setPositions(values) {
            this.positions = values;
            this.vertexBuffer.numBytes += values.byteLength;
        }

        setNormals(values) {
            this.normals = values;
            this.vertexBuffer.numBytes += values.byteLength;
        }

        setUvs(_channel, values) {
            this.uvs = values;
            this.vertexBuffer.numBytes += values.byteLength;
        }

        setColors(values) {
            this.colors = values;
            this.vertexBuffer.numBytes += values.byteLength;
        }

        setIndices(values) {
            this.indices = values;
            this.indexBuffer[0].numBytes = values.byteLength;
        }

        update() {}

        destroy() {
            this.destroyed = true;
        }
    }

    class Texture {
        constructor(_device, options) {
            Object.assign(this, options);
            this.width = 2;
            this.height = 2;
        }

        setSource(source) {
            this.source = source;
            this.width = source.width;
            this.height = source.height;
        }

        destroy() {
            this.destroyed = true;
        }
    }

    class Entity {
        constructor(name = '') {
            this.name = name;
            this.children = [];
            this.enabled = true;
        }

        addChild(child) {
            this.children.push(child);
            child.parent = this;
        }

        addComponent(type, data) {
            this[type] = data;
        }

        setLocalPosition(...value) {
            this.localPosition = value;
        }

        setLocalEulerAngles(...value) {
            this.localEulerAngles = value;
        }

        setLocalRotation(...value) {
            this.localRotation = value;
        }

        setLocalScale(...value) {
            this.localScale = value;
        }

        findComponents(type) {
            const result = this[type] ? [this[type]] : [];
            for (const child of this.children) result.push(...child.findComponents(type));
            return result;
        }

        destroy() {
            this.destroyed = true;
        }
    }

    class Mat4 {
        constructor() {
            this.data = new Float32Array(16);
        }

        getTranslation() {
            return { x: this.data[12], y: this.data[13], z: this.data[14] };
        }

        getEulerAngles() {
            return { x: 0, y: 0, z: 0 };
        }

        getScale() {
            return { x: 1, y: 1, z: 1 };
        }
    }

    class MeshInstance {
        constructor(mesh, material) {
            this.mesh = mesh;
            this.material = material;
        }
    }

    const app = new Emitter();
    app.graphicsDevice = {
        maxAnisotropy: 8,
        isWebGPU: false,
        setTexture() {
            textureUploadCount++;
        },
        setVertexBuffer() {},
        setIndexBuffer() {}
    };
    app.assets = {
        add() {},
        load(asset) {
            assetLoadCount++;
            asset.resource = {
                textures: Array.from({ length: textureCount }, (_, index) => ({
                    resource: { width: 16 + index, height: 16 + index, mipmaps: true }
                })),
                instantiateRenderEntity() {
                    const deadline = performance.now() + instantiateDelayMs;
                    while (performance.now() < deadline) { /* simulate non-interruptible PlayCanvas work */ }
                    instantiateCount++;
                    return entity;
                }
            };
            queueMicrotask(() => asset.fire('load', asset));
        },
        remove() {
            removedAssets++;
        }
    };
    const parent = {
        children: [],
        addChild(child) {
            this.children.push(child);
        }
    };
    const terratile = { DerivedResourceCache, collectDerivedTransferables, parseDerivedGlb };
    const pc = {
        Asset,
        Entity,
        Mat4,
        Mesh,
        MeshInstance,
        StandardMaterial: Material,
        Texture,
        ADDRESS_CLAMP_TO_EDGE: 1,
        ADDRESS_MIRRORED_REPEAT: 2,
        ADDRESS_REPEAT: 3,
        BLEND_NORMAL: 1,
        CULLFACE_BACK: 1,
        CULLFACE_NONE: 0,
        FILTER_LINEAR: 1,
        FILTER_LINEAR_MIPMAP_LINEAR: 2,
        FILTER_LINEAR_MIPMAP_NEAREST: 3,
        FILTER_NEAREST: 4,
        FILTER_NEAREST_MIPMAP_LINEAR: 5,
        FILTER_NEAREST_MIPMAP_NEAREST: 6,
        PRIMITIVE_TRIANGLES: 4,
        dracoInitialize: config => {
            workerConfig.draco = config;
        },
        basisInitialize: config => {
            workerConfig.basis = config;
        }
    };
    const context = vm.createContext({
        terratile,
        pc,
        navigator: { hardwareConcurrency, deviceMemory, userAgent: 'Desktop Test' },
        performance,
        URL,
        location: { href: 'https://example.test/viewer/' },
        console,
        setInterval,
        clearInterval,
        setTimeout,
        queueMicrotask,
        Blob,
        createImageBitmap: async () => ({ width: 2, height: 2, close() {} })
    });
    vm.runInContext(integrationSource, context);

    return {
        app,
        parent,
        terratile,
        workerConfig,
        entity,
        meshInstances,
        sourceMaterial,
        counters: () => ({
            materialCloneCount,
            instantiateCount,
            assetLoadCount,
            textureUploadCount,
            removedAssets
        })
    };
}

async function drain(app, promise, maxFrames = 240) {
    let settled = false;
    promise.finally(() => {
        settled = true;
    });
    for (let frame = 0; frame < maxFrames && !settled; frame++) {
        app.fire('update', 1 / 60);
        app.fire('frameend');
        // Asset and promise callbacks settle on microtasks.
        // eslint-disable-next-line no-await-in-loop
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(settled, true, `preparation did not settle within ${maxFrames} simulated frames`);
    return promise;
}

test('desktop worker profile uses 12 Draco and 6 Basis workers on 24 threads', () => {
    const { terratile } = createHarness({ hardwareConcurrency: 24 });
    const profile = terratile.playcanvas.selectWorkerProfile({ hardwareConcurrency: 24 });
    assert.equal(profile.profile, 'desktop');
    assert.equal(profile.dracoWorkers, 12);
    assert.equal(profile.basisWorkers, 6);
});

test('resident cache profile scales up on a high-end desktop', () => {
    const { terratile } = createHarness({ hardwareConcurrency: 16, deviceMemory: 8 });
    const profile = terratile.playcanvas.selectResidentProfile({
        profile: 'desktop',
        hardwareConcurrency: 16,
        deviceMemory: 8
    });
    assert.equal(profile.maxResidentTiles, 800);
    assert.equal(profile.maxResidentSourceBytes, 1024 * 1024 * 1024);
    assert.equal(profile.maxResidentGpuBytes, 2048 * 1024 * 1024);
});

test('adaptive tuning preserves a locked 128-request allowance while backing off CPU stages', () => {
    const { app, parent, terratile } = createHarness({ hardwareConcurrency: 16, deviceMemory: 8 });
    let frameCost = 24;
    const manager = {
        maxConcurrentRequests: 128,
        maxConcurrentDecodes: 12,
        maxDownloadedBytes: 256 * 1024 * 1024,
        maxSpeculativeRequestsPerFrame: 8,
        predictiveLookAheadSeconds: 1.5,
        getStreamingStats() {
            return {
                queues: {
                    queuedNetwork: 100,
                    queuedDecode: 12,
                    queuedPrepare: 20,
                    downloadedBytes: 64 * 1024 * 1024
                },
                renderer: {
                    queues: {
                        recentFrameCostMs: frameCost,
                        targetFrameMs: 1000 / 60,
                        cameraSpeed: 30
                    },
                    counters: { longTasks: 0 }
                }
            };
        }
    };
    const renderer = new terratile.playcanvas.TileRenderer({
        app,
        parent,
        adaptiveTuning: { sampleFrames: 10, networkMin: 128, networkMax: 128 }
    });
    renderer.attachManager(manager);
    const initialPrepareBudget = renderer.maxPrepareBudgetMs;
    for (let i = 0; i < 10; i++) app.fire('frameend');

    assert.equal(manager.maxConcurrentRequests, 128);
    assert.equal(manager.maxConcurrentDecodes, 11);
    assert.ok(renderer.maxPrepareBudgetMs < initialPrepareBudget);
    assert.equal(manager.maxSpeculativeRequestsPerFrame, 6);

    frameCost = 8;
    for (let i = 0; i < 10; i++) app.fire('frameend');
    assert.equal(manager.maxConcurrentRequests, 128);
    assert.equal(manager.maxConcurrentDecodes, 12);
    assert.equal(manager.maxSpeculativeRequestsPerFrame, 7);
    renderer.dispose();
});

test('adaptive tuning reduces network concurrency below 128 when the configured range permits it', () => {
    const { app, parent, terratile } = createHarness({ hardwareConcurrency: 16, deviceMemory: 8 });
    const manager = {
        maxConcurrentRequests: 128,
        maxConcurrentDecodes: 12,
        maxDownloadedBytes: 256 * 1024 * 1024,
        maxSpeculativeRequestsPerFrame: 8,
        predictiveLookAheadSeconds: 1.5,
        getStreamingStats() {
            return {
                queues: { queuedNetwork: 100, queuedDecode: 12, queuedPrepare: 20, downloadedBytes: 0 },
                renderer: {
                    queues: { recentFrameCostMs: 24, targetFrameMs: 1000 / 60, cameraSpeed: 30 },
                    counters: { longTasks: 0 }
                }
            };
        }
    };
    const renderer = new terratile.playcanvas.TileRenderer({
        app,
        parent,
        adaptiveTuning: { sampleFrames: 10, networkMin: 24, networkMax: 128 }
    });
    renderer.attachManager(manager);
    for (let i = 0; i < 10; i++) app.fire('frameend');

    assert.equal(manager.maxConcurrentRequests, 120);
    renderer.dispose();
});

test('derived GLB resource builds an emissive unlit textured mesh with its node transform', async () => {
    const { app, parent, terratile } = createHarness({ hardwareConcurrency: 16, deviceMemory: 8 });
    const renderer = new terratile.playcanvas.TileRenderer({ app, parent, adaptiveTuning: false });
    const derived = {
        schema: 1,
        sourceByteLength: 256,
        derivedByteLength: 128,
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{
            name: 'tile-node',
            mesh: 0,
            children: [],
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1]
        }],
        meshes: [{
            primitives: [{
                positions: { buffer: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer, components: 3 },
                normals: null,
                uvs: { buffer: new Float32Array([0, 0, 1, 0, 0, 1]).buffer, components: 2 },
                colors: null,
                indices: { buffer: new Uint32Array([0, 1, 2]).buffer, components: 1 },
                material: 0,
                mode: 4
            }]
        }],
        materials: [{
            name: 'unlit',
            baseColorFactor: [1, 1, 1, 1],
            baseColorTexture: 0,
            doubleSided: false,
            alphaMode: 'OPAQUE',
            unlit: true
        }],
        textures: [{ source: 0, sampler: 0 }],
        samplers: [{}],
        images: [{ mimeType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer }]
    };
    const decoded = await renderer._decodeDerived('tile.glb', 'https://example.test/tile.glb', derived);
    const node = {};
    const preparing = renderer.prepare(node, decoded, { priority: 1, requestInit: {} });
    await drain(app, preparing);

    const root = renderer.getEntity(node);
    const tileNode = root.children[0];
    const material = tileNode.render.meshInstances[0].material;
    assert.deepEqual(tileNode.localPosition, [10, 20, 30]);
    assert.ok(material.emissiveMap);
    assert.equal(material.diffuseMap, null);
    assert.equal(material.useLighting, false);
    assert.equal(material.useSkybox, false);
    renderer.dispose();
});

test('renderer prepares disabled tiles, shares dither materials and restores residents synchronously', async () => {
    const harness = createHarness();
    const changes = [];
    const renderer = new harness.terratile.playcanvas.TileRenderer({
        app: harness.app,
        parent: harness.parent,
        maxResidentTiles: 4,
        onTileChanged: change => changes.push(change.type),
        prepareQueue: { texturesPerStep: 1, meshBuffersPerStep: 1 }
    });
    const node = {
        content: { uri: 'tile.glb' },
        boundingVolume: { box: [10, 20, 30] }
    };
    const bytes = new ArrayBuffer(1024);
    const request = { url: 'https://example.test/tile.glb', priority: 1, requestInit: {} };
    const decoded = await renderer.decode(node, bytes, request);
    const prepared = renderer.prepare(node, decoded, request);
    harness.app.fire('update', 1 / 60);
    harness.app.fire('frameend');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(harness.counters().textureUploadCount <= 1,
        'texture upload count is globally bounded per frame');
    assert.equal(renderer.hasEntity(node), false, 'partial uploads are not render ready');
    await drain(harness.app, prepared);

    assert.equal(renderer.hasEntity(node), true);
    assert.equal(harness.entity.enabled, false, 'preparation must not expose the tile');
    assert.equal(harness.counters().assetLoadCount, 1);
    assert.equal(harness.counters().instantiateCount, 1);
    assert.equal(harness.counters().textureUploadCount, 3);
    assert.equal(harness.sourceMaterial.useLighting, false);

    renderer.setFade(node, 0.5, 'in');
    assert.equal(harness.meshInstances[0].material, harness.meshInstances[1].material,
        'compatible mesh instances share one dither material');
    assert.equal(harness.counters().materialCloneCount, 1,
        'the dither material was cached during preparation');
    renderer.setFade(node, 1, 'steady');
    assert.equal(harness.meshInstances[0].material, harness.sourceMaterial);

    renderer.show(node);
    assert.equal(harness.entity.enabled, true);
    renderer.unload(node);
    assert.equal(renderer.hasEntity(node), false);
    assert.equal(renderer.hasResident(node), true);
    assert.equal(harness.entity.destroyed, false);

    assert.equal(renderer.restore(node), true);
    assert.equal(renderer.hasEntity(node), true);
    assert.equal(renderer.hasResident(node), false);
    assert.equal(harness.counters().assetLoadCount, 1, 'restore does not decode again');
    assert.equal(harness.counters().instantiateCount, 1, 'restore does not instantiate again');
    assert.deepEqual(changes, ['load', 'show', 'unload', 'restore']);

    const stats = renderer.getStreamingStats();
    assert.equal(stats.workers.draco, 12);
    assert.equal(stats.workers.basis, 6);
    assert.equal(stats.counters.restored, 1);
    assert.equal(stats.timings.instantiateMs.count, 1);
    assert.ok(stats.timings.textureUploadMs.count >= 3);
    renderer.dispose();
    assert.equal(harness.entity.destroyed, true);
    assert.equal(harness.counters().removedAssets, 1);
});

test('frame-headroom scheduling gives stationary catch-up more budget than fast movement', () => {
    const harness = createHarness();
    const renderer = new harness.terratile.playcanvas.TileRenderer({
        app: harness.app,
        parent: harness.parent,
        targetFrameMs: 16,
        maxPrepareBudgetMs: 12
    });
    const budgets = [];
    renderer._queue.flush = budget => budgets.push(budget);
    renderer._frame.recentCostMs = 5;
    renderer._frame.speed = 100;
    renderer._frameStartTime = performance.now() - 5;
    renderer._flushAtFrameEnd();
    renderer._frame.speed = 0;
    renderer._frameStartTime = performance.now() - 5;
    renderer._flushAtFrameEnd();
    assert.ok(budgets[1] > budgets[0]);
    renderer.dispose();
});

test('saturated host frames still advance an aged tile preparation every frame', async () => {
    const harness = createHarness({ textureCount: 0 });
    const renderer = new harness.terratile.playcanvas.TileRenderer({
        app: harness.app,
        parent: harness.parent,
        targetFrameMs: 16,
        minPrepareProgressBudgetMs: 0.5,
        adaptiveTuning: false
    });
    const node = { content: { uri: 'contended.glb' }, boundingVolume: { box: [0, 0, 0] } };
    const request = { url: 'https://example.test/contended.glb', requestInit: {} };
    const decoded = await renderer.decode(node, new ArrayBuffer(32), request);
    const prepared = renderer.prepare(node, decoded, request);
    const job = renderer._queue._jobs.get(node);
    job.enqueuedAt = performance.now() - renderer._queue.maxDeferralMs - 1;

    renderer._frame.recentCostMs = 40;
    renderer._frameStartTime = performance.now() - 40;
    renderer._flushAtFrameEnd();

    assert.notEqual(job.phase, 'instantiate', 'the contended frame made preparation progress');
    assert.equal(renderer.getStreamingStats().counters.forcedProgressFrames, 1);
    await drain(harness.app, prepared);
    renderer.dispose();
});

test('repeatable benchmark flight reports throughput and queue peaks', async () => {
    const harness = createHarness();
    let completed = 0;
    const manager = {
        getStreamingStats: () => ({
            queues: { activeNetwork: completed, queuedNetwork: 2, activeDecode: 1 },
            counters: { completed, networkBytes: completed * 1024, cancelled: 0, staleDropped: 0 },
            renderer: { workers: { draco: 8, basis: 4 }, counters: { longTasks: completed } }
        })
    };
    const position = { x: 0, y: 0, z: 0, clone() { return { x: this.x, y: this.y, z: this.z }; } };
    const camera = {
        getPosition: () => position,
        setPosition: (...args) => {
            if (args.length === 1) Object.assign(position, args[0]);
            else [position.x, position.y, position.z] = args;
        }
    };
    const benchmark = harness.terratile.playcanvas.runBenchmarkFlight({
        app: harness.app,
        manager,
        camera,
        waypoints: [[0, 0, 0], [100, 0, 0]],
        durationMs: 100,
        settleMs: 0
    });
    completed = 1;
    harness.app.fire('update', 0.05);
    completed = 2;
    harness.app.fire('update', 0.05);
    const report = await benchmark;
    assert.equal(report.frames.count, 2);
    assert.equal(report.throughput.completedTilesPerSecond, 20);
    assert.equal(report.throughput.longTasks, 2);
    assert.equal(report.queuePeaks.activeNetwork, 2);
    assert.deepEqual(report.workers, { draco: 8, basis: 4 });
});

test('non-interruptible preparation work is reported as a long task', async () => {
    const harness = createHarness({ textureCount: 0, instantiateDelayMs: 3 });
    const renderer = new harness.terratile.playcanvas.TileRenderer({
        app: harness.app,
        parent: harness.parent,
        prepareQueue: { longTaskMs: 1 }
    });
    const node = { content: { uri: 'long.glb' }, boundingVolume: { box: [0, 0, 0] } };
    const request = { url: 'https://example.test/long.glb', requestInit: {} };
    const decoded = await renderer.decode(node, new ArrayBuffer(32), request);
    await drain(harness.app, renderer.prepare(node, decoded, request));
    const stats = renderer.getStreamingStats();
    assert.ok(stats.counters.longTasks >= 1);
    assert.ok(stats.timings.longTaskMs.max >= 1);
    renderer.dispose();
});

test('resident eviction protects atomic fallback tiles', () => {
    const harness = createHarness();
    const renderer = new harness.terratile.playcanvas.TileRenderer({
        app: harness.app,
        parent: harness.parent,
        maxResidentTiles: 1,
        maxResidentSourceBytes: 1024,
        maxResidentGpuBytes: 1024
    });
    const protectedNode = { name: 'fallback' };
    const victimNode = { name: 'stale' };
    const makeRecord = (node) => ({
        node,
        entity: { enabled: false, destroy() { this.destroyed = true; } },
        asset: { unload() { this.unloaded = true; } },
        sourceBytes: 10,
        gpuBytes: 10,
        depth: 1,
        lastUsedFrame: 0,
        lastUsedTime: 0,
        distance: 100
    });
    const protectedRecord = makeRecord(protectedNode);
    const victimRecord = makeRecord(victimNode);
    renderer._resident.set(protectedNode, protectedRecord);
    renderer._resident.set(victimNode, victimRecord);
    renderer.setProtectedNodes(new Set([protectedNode]));
    renderer._evictResidents();
    assert.equal(renderer.hasResident(protectedNode), true);
    assert.equal(renderer.hasResident(victimNode), false);
    assert.equal(victimRecord.entity.destroyed, true);
    renderer.dispose();
});

test('an aborted preparation never becomes render ready', async () => {
    const harness = createHarness();
    const renderer = new harness.terratile.playcanvas.TileRenderer({
        app: harness.app,
        parent: harness.parent
    });
    const controller = new AbortController();
    const node = { content: { uri: 'cancel.glb' }, boundingVolume: { box: [0, 0, 0] } };
    const request = {
        url: 'https://example.test/cancel.glb',
        requestInit: { signal: controller.signal }
    };
    const decoded = await renderer.decode(node, new ArrayBuffer(128), request);
    const prepared = renderer.prepare(node, decoded, request);
    controller.abort();
    await assert.rejects(prepared, error => error.name === 'AbortError');
    assert.equal(renderer.hasEntity(node), false);
    assert.equal(renderer.hasResident(node), false);
    assert.equal(decoded.asset.unloaded, true);
    renderer.dispose();
});
