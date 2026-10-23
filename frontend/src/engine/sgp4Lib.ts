/* ============================================================
   The only place the engine imports satellite.js.
   ------------------------------------------------------------
   satellite.js 7's package entry ("satellite.js") also re-exports its
   Emscripten WASM runtimes (`export * from './wasm/index.js'`). The
   package has no `sideEffects: false`, so bundlers keep those modules;
   their builds use top-level await and node: imports, which makes
   Vite's default (iife) worker build fail and would add several hundred
   KB of never-loaded chunks. We therefore import the pure-JS SGP4
   modules from the package's dist files directly. The package `exports`
   map only exposes ".", hence the relative path into node_modules.
   If satellite.js is upgraded, re-check these paths (types are checked
   by tsc, so a moved file fails the build loudly).
   ============================================================ */

export { json2satrec } from '../../node_modules/satellite.js/dist/io.js'
export { sgp4 } from '../../node_modules/satellite.js/dist/propagation/sgp4.js'
export { gstime } from '../../node_modules/satellite.js/dist/propagation/gstime.js'
export { checkForDecay } from '../../node_modules/satellite.js/dist/propagation/check-for-decay.js'
export {
  degreesLat,
  degreesLong,
  eciToGeodetic,
} from '../../node_modules/satellite.js/dist/transforms.js'
export type { SatRec } from '../../node_modules/satellite.js/dist/propagation/SatRec.js'
export type { OMMJsonObject } from '../../node_modules/satellite.js/dist/common-types.js'
export type { PositionAndVelocity } from '../../node_modules/satellite.js/dist/common-types.js'
