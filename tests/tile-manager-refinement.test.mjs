import assert from 'node:assert/strict';
import test from 'node:test';

import { TileManager } from '../src/tile-manager.mjs';

function makeNode(name, geometricError, children = [], contentExt = '.glb') {
    const node = {
        name,
        geometricError,
        boundingVolume: {
            box: [
                0, 0, 0,
                10, 0, 0,
                0, 10, 0,
                0, 0, 10
            ]
        },
        content: contentExt ? { uri: `${name}${contentExt}` } : undefined,
        children
    };
    for (const child of children) child.__parent = node;
    return node;
}

function makeManager(root, ready, mode = 'atomic') {
    const source = {
        getRootRequest() {
            return { url: 'https://example.invalid/root.json' };
        },
        resolveRequest(url) {
            return { url };
        }
    };
    const manager = new TileManager(source, {
        hasEntity: node => ready.has(node)
    });
    manager._root = root;
    manager.refinementMode = mode;
    manager.maximumScreenSpaceError = 16;
    manager.maxFallbackSseFactor = 8;
    manager._frameSseDenom = 2 * Math.tan(Math.PI / 6);
    return manager;
}

function selectFrame(manager) {
    manager._frameNumber++;
    return manager._select([0, 0, 100], Math.PI / 3, 1000, null);
}

test('legacy refinement exposes ready children while siblings are missing', () => {
    const a = makeNode('a', 10);
    const b = makeNode('b', 10);
    const parent = makeNode('parent', 100, [a, b]);
    const ready = new Set([parent, a]);
    const manager = makeManager(parent, ready, 'legacy');

    const result = selectFrame(manager);

    assert.equal(result.selected.has(parent), false);
    assert.equal(result.selected.has(a), true);
    assert.equal(result.selected.has(b), false);
    assert.equal(manager._lastCoverageGapCount > 0, true);
});

test('atomic refinement holds the parent until the whole direct frontier is ready', () => {
    const a = makeNode('a', 10);
    const b = makeNode('b', 10);
    const parent = makeNode('parent', 100, [a, b]);
    const ready = new Set([parent, a]);
    const manager = makeManager(parent, ready);

    const result = selectFrame(manager);

    assert.deepEqual([...result.selected], [parent]);
    assert.equal(result.immune.has(a), true);
    assert.equal(result.requested.some(request => request.node === b), true);
    assert.equal(manager._lastAtomicHoldCount, 1);
    assert.equal(manager._lastCoverageGapCount, 0);
});

test('atomic hold speculatively requests known grandchildren without displaying them', () => {
    const grandchild = makeNode('grandchild', 1);
    const a = makeNode('a', 30, [grandchild]);
    const b = makeNode('b', 30);
    const parent = makeNode('parent', 100, [a, b]);
    const ready = new Set([parent, a]);
    const manager = makeManager(parent, ready);
    manager.speculativeDescendantDepth = 1;
    manager.maxSpeculativeRequestsPerFrame = 4;

    const result = selectFrame(manager);
    const frontier = result.requested.find(request => request.node === b);
    const speculative = result.requested.find(request => request.node === grandchild);

    assert.deepEqual([...result.selected], [parent]);
    assert.equal(frontier.requestClass, 'frontier');
    assert.equal(speculative.requestClass, 'speculative');
    assert.ok(frontier.priority > speculative.priority);
    assert.equal(result.selected.has(grandchild), false);
    assert.equal(manager._lastSpeculativeRequestCount, 1);
});

test('speculative descendant requests obey their per-frame cap', () => {
    const grandchildren = Array.from({ length: 6 }, (_, index) => makeNode(`grandchild-${index}`, 1));
    const readyChild = makeNode('ready-child', 30, grandchildren);
    const missingChild = makeNode('missing-child', 30);
    const parent = makeNode('bounded-parent', 100, [readyChild, missingChild]);
    const manager = makeManager(parent, new Set([parent, readyChild]));
    manager.maxSpeculativeRequestsPerFrame = 2;

    const result = selectFrame(manager);
    const speculative = result.requested.filter(request => request.requestClass === 'speculative');
    assert.equal(speculative.length, 2);
    assert.equal(manager._lastSpeculativeRequestCount, 2);
});

test('predictive corridor uses velocity and forward direction and rejects a 180-degree reversal', () => {
    const ahead = makeNode('ahead', 10);
    ahead.boundingVolume.box[0] = 100;
    const manager = makeManager(ahead, new Set());
    manager._cameraVelocityTileY = [20, 0, 0];
    manager._cameraForwardTileY = [1, 0, 0];
    const ctx = { cameraPos: [0, 0, 0] };

    assert.equal(manager._isPredictiveCandidate(ahead, ctx), true);
    manager._cameraVelocityTileY = [-20, 0, 0];
    manager._cameraForwardTileY = [-1, 0, 0];
    assert.equal(manager._isPredictiveCandidate(ahead, ctx), false);
    assert.equal(manager._isBehindCamera(ahead, ctx), true);
});

test('atomic refinement commits one complete frontier level before refining deeper', () => {
    const grandchild = makeNode('grandchild', 1);
    const a = makeNode('a', 30, [grandchild]);
    const b = makeNode('b', 10);
    const parent = makeNode('parent', 100, [a, b]);
    const ready = new Set([parent, a, b]);
    const manager = makeManager(parent, ready);

    const first = selectFrame(manager);
    assert.equal(first.selected.has(parent), false);
    assert.equal(first.selected.has(a), true);
    assert.equal(first.selected.has(b), true);
    assert.equal(first.selected.has(grandchild), false);

    const second = selectFrame(manager);
    assert.equal(second.selected.has(a), true);
    assert.equal(second.selected.has(b), true);
    assert.equal(second.requested.some(request => request.node === grandchild), true);
    assert.equal(manager._lastAtomicHoldCount, 1);
});

test('atomic refinement holds across unresolved external-tileset wrappers', () => {
    const wrapper = makeNode('subtree', 50, [], '.json');
    const parent = makeNode('parent', 100, [wrapper]);
    const ready = new Set([parent]);
    const manager = makeManager(parent, ready);

    const unresolved = selectFrame(manager);
    assert.deepEqual([...unresolved.selected], [parent]);
    assert.equal(unresolved.requested.some(request => request.node === wrapper), true);

    const inner = makeNode('inner', 10);
    inner.__parent = wrapper;
    wrapper.children = [inner];
    const discovered = selectFrame(manager);
    assert.deepEqual([...discovered.selected], [parent]);
    assert.equal(discovered.requested.some(request => request.node === inner), true);
});

test('atomic refinement walks deep external-tileset wrapper chains as one transparent frontier', () => {
    const inner = makeNode('deep-inner', 10);
    const wrapperB = makeNode('wrapper-b', 30, [inner], '.json');
    const wrapperA = makeNode('wrapper-a', 60, [wrapperB], '.json');
    const parent = makeNode('deep-parent', 100, [wrapperA]);
    const manager = makeManager(parent, new Set([parent]));

    const result = selectFrame(manager);
    assert.deepEqual([...result.selected], [parent]);
    assert.equal(result.requested.some(request => request.node === inner), true);
    assert.equal(result.requested.find(request => request.node === inner).requestClass, 'frontier');
});

test('atomic refinement keeps parent coverage when a replacement permanently fails', () => {
    const failed = makeNode('failed', 10);
    failed.__loadDead = true;
    const parent = makeNode('parent', 100, [failed]);
    const ready = new Set([parent]);
    const manager = makeManager(parent, ready);

    const result = selectFrame(manager);

    assert.deepEqual([...result.selected], [parent]);
    assert.equal(result.requested.length, 0);
    assert.equal(manager._lastCoverageGapCount, 0);
});

test('atomic refinement wakes a cooldown-expired replacement without an SSE change', () => {
    const recovering = makeNode('recovering', 10);
    recovering.__loadDead = true;
    recovering.__loadDeadUntilMs = Date.now() - 1;
    recovering.__nextLoadRetryMs = Date.now() - 1;
    const parent = makeNode('parent', 100, [recovering]);
    const manager = makeManager(parent, new Set([parent]));

    const result = selectFrame(manager);

    assert.deepEqual([...result.selected], [parent]);
    assert.equal(result.requested.some(request => request.node === recovering), true);
    assert.equal(recovering.__loadDead, undefined);
    assert.equal(manager._lastCoverageGapCount, 0);
});

test('basemap priority state depends on visible coverage rather than refinement backlog', () => {
    const child = makeNode('child', 10);
    const parent = makeNode('parent', 100, [child]);
    const manager = makeManager(parent, new Set([parent]));
    manager._prevSelected = new Set([parent]);

    assert.equal(manager.getBasemapPriorityState().ready, true);

    manager._pipelineJobs.set(child, { requestClass: 'coverage' });
    assert.equal(manager.getBasemapPriorityState().ready, true);

    manager._pipelineJobs.set(child, { requestClass: 'frontier' });
    const refining = manager.getBasemapPriorityState();
    assert.equal(refining.ready, true);
    assert.equal(refining.criticalJobs, 1);

    manager._pipelineJobs.clear();
    manager._lastCoverageGapCount = 1;
    assert.equal(manager.getBasemapPriorityState().critical, true);

    manager._lastCoverageGapCount = 0;
    manager._prevSelected.clear();
    assert.equal(manager.getBasemapPriorityState().critical, true);
});

test('mixed refinement selects parent and ready descendants without reporting a hole', () => {
    const a = makeNode('a', 10);
    const b = makeNode('b', 10);
    const parent = makeNode('parent', 100, [a, b]);
    const ready = new Set([parent, a]);
    const manager = makeManager(parent, ready, 'mixed');

    const result = selectFrame(manager);

    assert.equal(result.selected.has(parent), true);
    assert.equal(result.selected.has(a), true);
    assert.equal(result.selected.has(b), false);
    assert.equal(manager._lastCoverageGapCount, 0);
});

test('mixed refinement diffs renderer stencil state by selected node depth', () => {
    const child = makeNode('child', 10);
    const parent = makeNode('parent', 100, [child]);
    const ready = new Set([parent, child]);
    const configured = [];
    const cleared = [];
    const manager = makeManager(parent, ready, 'mixed');
    manager.handlers.setMixed = (node, depth) => configured.push([node, depth]);
    manager.handlers.clearMixed = node => cleared.push(node);

    manager._applyMixedSelectionState(new Set([parent, child]));
    assert.deepEqual(configured, [[parent, 0], [child, 1]]);

    manager._applyMixedSelectionState(new Set([child]));
    assert.deepEqual(cleared, [parent]);

    manager.refinementMode = 'atomic';
    manager._applyMixedSelectionState(new Set([child]));
    assert.deepEqual(cleared, [parent, child]);
});

test('selection revives a render-ready resident tile before showing it', () => {
    const root = makeNode('root', 1);
    const active = new Set();
    const resident = new Set([root]);
    let restoreCount = 0;
    let showCount = 0;
    const source = {
        getRootRequest: () => ({ url: 'https://example.invalid/root.json' }),
        resolveRequest: url => ({ url })
    };
    const manager = new TileManager(source, {
        hasEntity: node => active.has(node),
        hasResident: node => resident.has(node),
        restore: node => {
            if (!resident.delete(node)) return false;
            active.add(node);
            restoreCount++;
            return true;
        },
        show: node => {
            assert.equal(active.has(node), true);
            showCount++;
        },
        hide: () => {}
    });
    manager._root = root;
    manager._frameSseDenom = 2 * Math.tan(Math.PI / 6);

    manager._updateCoreSelection([0, 0, 100], Math.PI / 3, 1000, null);

    assert.equal(restoreCount, 1);
    assert.equal(showCount, 1);
    assert.equal(manager._loadedNodes.has(root), true);
    assert.equal(manager._loadedGlbCount, 1);
    assert.equal(root.__contentLoaded, true);
});

test('atomic dither transition keeps complementary parent and children selected until completion', () => {
    const a = makeNode('a', 10);
    const b = makeNode('b', 10);
    const parent = makeNode('parent', 100, [a, b]);
    const ready = new Set([parent, a, b]);
    const fades = [];
    const manager = makeManager(parent, ready);
    manager.transitionMode = 'dither';
    manager.transitionFrames = 2;
    manager.handlers.setFade = (node, progress, direction) => {
        fades.push({ node, progress, direction });
    };

    const start = selectFrame(manager);
    assert.equal(start.selected.has(parent), true);
    assert.equal(start.selected.has(a), true);
    assert.equal(start.selected.has(b), true);
    assert.equal(manager._activeTransitions.size, 1);
    assert.equal(fades.some(f => f.node === parent && f.progress === 0 && f.direction === 'out'), true);

    const middle = selectFrame(manager);
    assert.equal(middle.selected.has(parent), true);
    assert.equal(fades.some(f => f.node === a && f.progress === 0.5 && f.direction === 'in'), true);

    const finished = selectFrame(manager);
    assert.equal(finished.selected.has(parent), false);
    assert.equal(finished.selected.has(a), true);
    assert.equal(finished.selected.has(b), true);
    assert.equal(manager._activeTransitions.size, 0);
    assert.equal(fades.some(f => f.node === parent && f.direction === 'steady'), true);
});
