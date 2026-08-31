import assert from 'node:assert/strict';
import test from 'node:test';
import { indexedDB } from 'fake-indexeddb';

import { DerivedResourceCache } from '../src/derived-cache.mjs';
import { collectDerivedTransferables, parseDerivedGlb } from '../src/glb-derived-parser.mjs';

Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value: indexedDB
});

function align4(value) {
    return (value + 3) & ~3;
}

function makeGlb(mutate = null) {
    const indices = new Uint16Array([0, 1, 2]);
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    const uvs = new Float32Array([0, 0, 1, 0, 0, 1]);
    const image = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const indicesOffset = 0;
    const positionsOffset = align4(indices.byteLength);
    const uvsOffset = positionsOffset + positions.byteLength;
    const imageOffset = uvsOffset + uvs.byteLength;
    const binary = new Uint8Array(align4(imageOffset + image.byteLength));
    binary.set(new Uint8Array(indices.buffer), indicesOffset);
    binary.set(new Uint8Array(positions.buffer), positionsOffset);
    binary.set(new Uint8Array(uvs.buffer), uvsOffset);
    binary.set(image, imageOffset);
    const gltf = {
        asset: { version: '2.0' },
        extensionsUsed: ['KHR_materials_unlit'],
        buffers: [{ byteLength: binary.byteLength }],
        bufferViews: [
            { buffer: 0, byteOffset: indicesOffset, byteLength: indices.byteLength },
            { buffer: 0, byteOffset: positionsOffset, byteLength: positions.byteLength },
            { buffer: 0, byteOffset: uvsOffset, byteLength: uvs.byteLength },
            { buffer: 0, byteOffset: imageOffset, byteLength: image.byteLength }
        ],
        accessors: [
            { bufferView: 0, componentType: 5123, count: 3, type: 'SCALAR' },
            { bufferView: 1, componentType: 5126, count: 3, type: 'VEC3' },
            { bufferView: 2, componentType: 5126, count: 3, type: 'VEC2' }
        ],
        images: [{ bufferView: 3, mimeType: 'image/jpeg' }],
        samplers: [{}],
        textures: [{ source: 0, sampler: 0 }],
        materials: [{
            pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
            extensions: { KHR_materials_unlit: {} }
        }],
        meshes: [{ primitives: [{ attributes: { POSITION: 1, TEXCOORD_0: 2 }, indices: 0, material: 0 }] }],
        nodes: [{ mesh: 0, matrix: [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 10, 20, 30, 1] }],
        scenes: [{ nodes: [0] }],
        scene: 0
    };
    mutate?.(gltf);
    const jsonRaw = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonLength = align4(jsonRaw.byteLength);
    const total = 12 + 8 + jsonLength + 8 + binary.byteLength;
    const output = new ArrayBuffer(total);
    const view = new DataView(output);
    view.setUint32(0, 0x46546C67, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonLength, true);
    view.setUint32(16, 0x4E4F534A, true);
    const jsonChunk = new Uint8Array(output, 20, jsonLength);
    jsonChunk.fill(0x20);
    jsonChunk.set(jsonRaw);
    const binaryHeader = 20 + jsonLength;
    view.setUint32(binaryHeader, binary.byteLength, true);
    view.setUint32(binaryHeader + 4, 0x004E4942, true);
    new Uint8Array(output, binaryHeader + 8).set(binary);
    return output;
}

test('worker-derived GLB parser extracts render streams and embedded imagery', () => {
    const result = parseDerivedGlb(makeGlb());
    assert.equal(result.supported, true);
    assert.equal(result.derived.meshes.length, 1);
    const primitive = result.derived.meshes[0].primitives[0];
    assert.deepEqual([...new Float32Array(primitive.positions.buffer)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
    assert.deepEqual([...new Float32Array(primitive.uvs.buffer)], [0, 0, 1, 0, 0, 1]);
    assert.deepEqual([...new Uint32Array(primitive.indices.buffer)], [0, 1, 2]);
    assert.deepEqual([...new Uint8Array(result.derived.images[0].bytes)], [0xff, 0xd8, 0xff, 0xd9]);
    assert.equal(result.derived.nodes[0].matrix[12], 10);
    assert.equal(collectDerivedTransferables(result).length, 4);
});

test('derived resources persist across cache instances', async () => {
    const dbName = `terratile-derived-test-${Date.now()}-${Math.random()}`;
    const parsed = parseDerivedGlb(makeGlb()).derived;
    const first = new DerivedResourceCache({ dbName, maxBytes: 1024 * 1024, persistent: true });
    await first.put('tile-v1', parsed, parsed.derivedByteLength);
    const second = new DerivedResourceCache({ dbName, maxBytes: 1024 * 1024, persistent: true });
    const restored = await second.get('tile-v1');

    assert.ok(restored);
    assert.equal(restored.schema, 1);
    assert.deepEqual([...new Uint32Array(restored.meshes[0].primitives[0].indices.buffer)], [0, 1, 2]);
    assert.equal(second.snapshot().persistentHits, 1);
    await second.clear();
});

test('derived resource cache defaults to page-session memory only', () => {
    assert.equal(new DerivedResourceCache().snapshot().persistent, false);
});

test('unsupported compressed primitives fall back cleanly', () => {
    const result = parseDerivedGlb(makeGlb(gltf => {
        gltf.extensionsRequired = ['KHR_draco_mesh_compression'];
        gltf.meshes[0].primitives[0].extensions = { KHR_draco_mesh_compression: {} };
    }));
    assert.equal(result.supported, false);
    assert.match(result.reason, /required-extension|compressed/);
});
