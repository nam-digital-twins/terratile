/**
 * Parse the uncompressed, embedded-resource GLB subset used by Google
 * Photorealistic 3D Tiles into structured-clone-friendly render data.
 *
 * Unsupported GLB features deliberately return `supported: false`; callers
 * must fall back to their engine's complete parser. Keeping the fast path
 * strict preserves visual correctness while moving JSON/accessor extraction
 * off the main thread for the common tile shape.
 *
 * @param {ArrayBuffer|ArrayBufferView} input - Original GLB bytes.
 * @returns {{supported: boolean, reason: string, derived: object}} Parsed
 * derived data or an explicit fallback reason.
 */
function parseDerivedGlb(input) {
    const unsupported = reason => ({ supported: false, reason });
    const source = input instanceof ArrayBuffer ? input :
        input?.buffer?.slice(input.byteOffset, input.byteOffset + input.byteLength);
    if (!(source instanceof ArrayBuffer) || source.byteLength < 20) return unsupported('invalid-buffer');

    const view = new DataView(source);
    if (view.getUint32(0, true) !== 0x46546C67) return unsupported('not-glb');
    if (view.getUint32(4, true) !== 2) return unsupported('unsupported-glb-version');
    const declaredLength = view.getUint32(8, true);
    if (declaredLength > source.byteLength || declaredLength < 20) return unsupported('invalid-glb-length');

    let offset = 12;
    let jsonBytes = null;
    let binaryOffset = 0;
    let binaryLength = 0;
    while (offset + 8 <= declaredLength) {
        const chunkLength = view.getUint32(offset, true);
        const chunkType = view.getUint32(offset + 4, true);
        const chunkStart = offset + 8;
        if (chunkStart + chunkLength > declaredLength) return unsupported('invalid-chunk-length');
        if (chunkType === 0x4E4F534A) jsonBytes = new Uint8Array(source, chunkStart, chunkLength);
        if (chunkType === 0x004E4942) {
            binaryOffset = chunkStart;
            binaryLength = chunkLength;
        }
        offset = chunkStart + chunkLength;
    }
    if (!jsonBytes || binaryLength === 0) return unsupported('missing-json-or-binary-chunk');

    let gltf;
    try {
        gltf = JSON.parse(new TextDecoder().decode(jsonBytes).trim());
    } catch {
        return unsupported('invalid-gltf-json');
    }
    if (Number.parseFloat(gltf.asset?.version ?? '0') < 2) return unsupported('unsupported-gltf-version');
    const allowedExtensions = new Set(['KHR_materials_unlit']);
    for (const extension of gltf.extensionsRequired ?? []) {
        if (!allowedExtensions.has(extension)) return unsupported(`required-extension:${extension}`);
    }
    if ((gltf.buffers?.length ?? 0) !== 1 || gltf.buffers[0]?.uri) return unsupported('external-or-multiple-buffers');
    if (gltf.skins?.length || gltf.animations?.length || gltf.morphTargets?.length) {
        return unsupported('animated-or-skinned-content');
    }

    const componentsForType = {
        SCALAR: 1,
        VEC2: 2,
        VEC3: 3,
        VEC4: 4,
        MAT2: 4,
        MAT3: 9,
        MAT4: 16
    };
    const componentInfo = {
        5120: { bytes: 1, read: (data, at) => data.getInt8(at), signed: true, max: 127 },
        5121: { bytes: 1, read: (data, at) => data.getUint8(at), signed: false, max: 255 },
        5122: { bytes: 2, read: (data, at) => data.getInt16(at, true), signed: true, max: 32767 },
        5123: { bytes: 2, read: (data, at) => data.getUint16(at, true), signed: false, max: 65535 },
        5125: { bytes: 4, read: (data, at) => data.getUint32(at, true), signed: false, max: 4294967295 },
        5126: { bytes: 4, read: (data, at) => data.getFloat32(at, true), float: true }
    };
    const readAccessor = (index, indices = false) => {
        const accessor = gltf.accessors?.[index];
        if (!accessor || accessor.bufferView == null || accessor.sparse) throw new Error('unsupported-accessor');
        const bufferView = gltf.bufferViews?.[accessor.bufferView];
        if (!bufferView || Number(bufferView.buffer ?? 0) !== 0) throw new Error('invalid-buffer-view');
        const component = componentInfo[accessor.componentType];
        const components = componentsForType[accessor.type];
        if (!component || !components || accessor.count < 0) throw new Error('invalid-accessor-format');
        const packedStride = component.bytes * components;
        const stride = Number(bufferView.byteStride) || packedStride;
        if (stride < packedStride) throw new Error('invalid-byte-stride');
        const start = binaryOffset + Number(bufferView.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0);
        const end = start + Math.max(0, accessor.count - 1) * stride + packedStride;
        if (start < binaryOffset || end > binaryOffset + binaryLength) throw new Error('accessor-out-of-range');
        const output = indices ? new Uint32Array(accessor.count * components) :
            new Float32Array(accessor.count * components);
        let outputIndex = 0;
        for (let element = 0; element < accessor.count; element++) {
            const elementStart = start + element * stride;
            for (let c = 0; c < components; c++) {
                let value = component.read(view, elementStart + c * component.bytes);
                if (!indices && accessor.normalized && !component.float) {
                    value = component.signed ? Math.max(-1, value / component.max) : value / component.max;
                }
                output[outputIndex++] = value;
            }
        }
        return {
            buffer: output.buffer,
            count: accessor.count,
            components,
            componentType: indices ? 5125 : 5126,
            normalized: false
        };
    };

    const images = [];
    try {
        for (const image of gltf.images ?? []) {
            if (image.uri || image.bufferView == null || !image.mimeType) throw new Error('external-image');
            const bufferView = gltf.bufferViews?.[image.bufferView];
            if (!bufferView || Number(bufferView.buffer ?? 0) !== 0) throw new Error('invalid-image-view');
            const start = binaryOffset + Number(bufferView.byteOffset ?? 0);
            const length = Number(bufferView.byteLength) || 0;
            if (start < binaryOffset || start + length > binaryOffset + binaryLength) throw new Error('image-out-of-range');
            images.push({
                mimeType: image.mimeType,
                bytes: source.slice(start, start + length),
                name: image.name ?? ''
            });
        }
    } catch (error) {
        return unsupported(error.message);
    }

    let materials;
    try {
        materials = (gltf.materials ?? []).map((material) => {
            const pbr = material.pbrMetallicRoughness ?? {};
            const textureInfo = pbr.baseColorTexture ?? null;
            if (textureInfo?.extensions) throw new Error('texture-transform-or-extension');
            return {
                name: material.name ?? '',
                baseColorFactor: (pbr.baseColorFactor ?? [1, 1, 1, 1]).slice(0, 4),
                baseColorTexture: textureInfo?.index ?? null,
                doubleSided: material.doubleSided === true,
                alphaMode: material.alphaMode ?? 'OPAQUE',
                alphaCutoff: Number(material.alphaCutoff ?? 0.5),
                unlit: !!material.extensions?.KHR_materials_unlit
            };
        });
    } catch (error) {
        return unsupported(error.message);
    }

    const allowedAttributes = new Set(['POSITION', 'NORMAL', 'TEXCOORD_0', 'COLOR_0']);
    let meshes;
    try {
        meshes = (gltf.meshes ?? []).map(mesh => ({
            name: mesh.name ?? '',
            primitives: (mesh.primitives ?? []).map((primitive) => {
                if ((primitive.mode ?? 4) !== 4) throw new Error('non-triangle-primitive');
                if (primitive.extensions) throw new Error('compressed-or-extended-primitive');
                if (primitive.targets?.length) throw new Error('morph-targets');
                for (const semantic of Object.keys(primitive.attributes ?? {})) {
                    if (!allowedAttributes.has(semantic)) throw new Error(`unsupported-attribute:${semantic}`);
                }
                if (primitive.attributes?.POSITION == null) throw new Error('missing-position');
                return {
                    positions: readAccessor(primitive.attributes.POSITION),
                    normals: primitive.attributes.NORMAL == null ? null : readAccessor(primitive.attributes.NORMAL),
                    uvs: primitive.attributes.TEXCOORD_0 == null ? null : readAccessor(primitive.attributes.TEXCOORD_0),
                    colors: primitive.attributes.COLOR_0 == null ? null : readAccessor(primitive.attributes.COLOR_0),
                    indices: primitive.indices == null ? null : readAccessor(primitive.indices, true),
                    material: primitive.material ?? null,
                    mode: 4
                };
            })
        }));
    } catch (error) {
        return unsupported(error.message);
    }

    const textures = (gltf.textures ?? []).map(texture => ({
        name: texture.name ?? '',
        source: texture.source ?? null,
        sampler: texture.sampler ?? null
    }));
    const samplers = (gltf.samplers ?? []).map(sampler => ({
        magFilter: sampler.magFilter ?? 9729,
        minFilter: sampler.minFilter ?? 9987,
        wrapS: sampler.wrapS ?? 10497,
        wrapT: sampler.wrapT ?? 10497
    }));
    const nodes = (gltf.nodes ?? []).map(node => ({
        name: node.name ?? '',
        mesh: node.mesh ?? null,
        children: (node.children ?? []).slice(),
        matrix: node.matrix?.slice(0, 16) ?? null,
        translation: node.translation?.slice(0, 3) ?? null,
        rotation: node.rotation?.slice(0, 4) ?? null,
        scale: node.scale?.slice(0, 3) ?? null
    }));
    const scenes = (gltf.scenes ?? []).map(scene => ({
        name: scene.name ?? '',
        nodes: (scene.nodes ?? []).slice()
    }));

    let derivedByteLength = 0;
    for (const image of images) derivedByteLength += image.bytes.byteLength;
    for (const mesh of meshes) {
        for (const primitive of mesh.primitives) {
            for (const stream of [primitive.positions, primitive.normals, primitive.uvs, primitive.colors, primitive.indices]) {
                derivedByteLength += stream?.buffer?.byteLength ?? 0;
            }
        }
    }
    return {
        supported: true,
        derived: {
            schema: 1,
            sourceByteLength: source.byteLength,
            derivedByteLength,
            scene: gltf.scene ?? 0,
            scenes,
            nodes,
            meshes,
            materials,
            textures,
            samplers,
            images
        }
    };
}

function collectDerivedTransferables(result) {
    const transferables = [];
    const derived = result?.derived;
    if (!derived) return transferables;
    for (const image of derived.images ?? []) if (image.bytes) transferables.push(image.bytes);
    for (const mesh of derived.meshes ?? []) {
        for (const primitive of mesh.primitives ?? []) {
            for (const stream of [primitive.positions, primitive.normals, primitive.uvs, primitive.colors, primitive.indices]) {
                if (stream?.buffer) transferables.push(stream.buffer);
            }
        }
    }
    return transferables;
}

export { collectDerivedTransferables, parseDerivedGlb };
