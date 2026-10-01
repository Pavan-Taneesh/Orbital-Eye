// Pure JS SGP4 wrapper - re-exports only the non-WASM functions from local satellite.js copy
// This avoids the WASM/pthreads build issues with Vite

// @ts-ignore
export { twoline2satrec, json2satrec } from './satellite/io.js'
// @ts-ignore
export { jday, invjday } from './satellite/ext.js'
// @ts-ignore
export { propagate, sgp4, gstime } from './satellite/propagation.js'
// @ts-ignore
export { checkForDecay } from './satellite/propagation/check-for-decay.js'
// @ts-ignore
export { degreesToRadians, radiansToDegrees, eciToEcf, ecfToEci, geodeticToEcf, eciToGeodetic, ecfToLookAngles, degreesLat, degreesLong, radiansLat, radiansLong } from './satellite/transforms.js'
// @ts-ignore
export { dopplerFactor } from './satellite/dopplerFactor.js'
// @ts-ignore
export { sunPos } from './satellite/sun.js'
// @ts-ignore
export * from './satellite/shadow.js'
// @ts-ignore
export { SatRecError } from './satellite/propagation/SatRec.js'
// @ts-ignore
export * from './satellite/common-types.js'
// @ts-ignore
export type { SatRec } from './satellite/propagation/SatRec.js'