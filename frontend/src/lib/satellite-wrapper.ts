// Pure JS SGP4 wrapper - re-exports only the non-WASM functions from local satellite.js copy
// This avoids the WASM/pthreads build issues with Vite

// @ts-expect-error vendored pure JS module without types
export { twoline2satrec, json2satrec } from './satellite/io.js'
// @ts-expect-error vendored pure JS module without types
export { jday, invjday } from './satellite/ext.js'
// @ts-expect-error vendored pure JS module without types
export { propagate, sgp4, gstime } from './satellite/propagation.js'
// @ts-expect-error vendored pure JS module without types
export { checkForDecay } from './satellite/propagation/check-for-decay.js'
// @ts-expect-error vendored pure JS module without types
export { degreesToRadians, radiansToDegrees, eciToEcf, ecfToEci, geodeticToEcf, eciToGeodetic, ecfToLookAngles, degreesLat, degreesLong, radiansLat, radiansLong } from './satellite/transforms.js'
// @ts-expect-error vendored pure JS module without types
export { dopplerFactor } from './satellite/dopplerFactor.js'
// @ts-expect-error vendored pure JS module without types
export { sunPos } from './satellite/sun.js'
// @ts-expect-error vendored pure JS module without types
export * from './satellite/shadow.js'
// @ts-expect-error vendored pure JS module without types
export { SatRecError } from './satellite/propagation/SatRec.js'
// @ts-expect-error vendored pure JS module without types
export * from './satellite/common-types.js'
// @ts-expect-error vendored pure JS module without types
export type { SatRec } from './satellite/propagation/SatRec.js'