import { readFileSync } from 'node:fs';

import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url)));

// Preserved license banner. The leading `/*!` plus the `@license` tag make
// standard JS minifiers (Terser, esbuild, etc.) keep this comment by default,
// so the copyright and attribution stay with the code in production.
const repo = 'https://github.com/nam-digital-twins/terratile';
const banner = `/*!
 * terratile v${pkg.version}
 * Copyright 2026 Ioannis L. Tsampras
 * NAM Research Group, ECE Dept., University of Patras <itsampras@ece.upatras.gr>
 * Source: ${repo}
 * Licensed under the Apache License, Version 2.0.
 * Includes earthatile (c) 2023 PlayCanvas, MIT (https://github.com/playcanvas/earthatile).
 * @license Apache-2.0
 */`;

export default {
    input: 'src/index.mjs',  // your main entry point
    output: {
        file: 'dist/terratile.js', // output bundled file
        format: 'umd',  // output type is UMD
        name: 'terratile', // the global variable name for your library
        banner
    },
    plugins: [
        nodeResolve(), // so Rollup can find external modules
        commonjs() // so Rollup can convert CommonJS to ES6
    ]
};
