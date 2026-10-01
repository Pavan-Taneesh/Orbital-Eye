// Type declarations for local satellite.js copy

declare module './satellite/constants.js' {
  export const earthRadius: number
  export const j2: number
  export const j3oj2: number
  export const j4: number
  export const pi: number
  export const twoPi: number
  export const vkmpersec: number
  export const x2o3: number
  export const xke: number
  export const tumin: number
  export const deg2rad: number
  export const rad2deg: number
  export const xpdotp: number
  export const minutesPerDay: number
  export const temp4: number
}

declare module './satellite/ext.js' {
  export function jday(year: number, month: number, day: number, hour: number, minute: number, second: number): number
  export function invjday(jd: number): { year: number; month: number; day: number; hour: number; minute: number; second: number }
  export function days2mdhms(year: number, days: number): { mon: number; day: number; hr: number; min: number; sec: number }
}

declare module './satellite/propagation.js' {
  export { gstime } from './satellite/propagation/gstime.js'
  export { propagate } from './satellite/propagation/propagate.js'
  export { sgp4 } from './satellite/propagation/sgp4.js'
}

declare module './satellite/propagation/sgp4.js' {
  import type { SatRec } from './satellite/SatRec.js'
  export function sgp4(satrec: SatRec, tsince: number): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; meanElements: any } | null
}

declare module './satellite/propagation/propagate.js' {
  import type { SatRec } from './satellite/SatRec.js'
  export function propagate(satrec: SatRec, ...args: any[]): { position: { x: number; y: number; z: number }; velocity: { x: number; y: number; z: number }; meanElements: any } | null
}

declare module './satellite/propagation/gstime.js' {
  export function gstime(date: Date): number
}

declare module './satellite/propagation/check-for-decay.js' {
  import type { SatRec } from './satellite/SatRec.js'
  export function checkForDecay(satrec: SatRec): boolean
}

declare module './satellite/propagation/dpper.js' {
  import type { SatRec } from './satellite/SatRec.js'
  export function dpper(satrec: SatRec, options: any): any
}

declare module './satellite/propagation/dspace.js' {
  export function dspace(options: any): { em: number; argpm: number; inclm: number; mm: number; nodem: number; nm: number }
}

declare module './satellite/propagation/SatRec.js' {
  export enum SatRecError {
    None = 0,
    MeanEccentricityOutOfRange = 1,
    MeanMotionBelowZero = 2,
    PerturbedEccentricityOutOfRange = 3,
    SemiLatusRectumBelowZero = 4,
    Decayed = 6,
  }
  export interface SatRec {
    satnum: string
    epochyr: number
    epochtynumrev: number
    error: SatRecError
    operationmode: 'a' | 'i'
    init: 'y' | 'n'
    method: 'n' | 'd'
    isimp: number
    aycof: number
    con41: number
    cc1: number
    cc4: number
    cc5: number
    d2: number
    d3: number
    d4: number
    delmo: number
    eta: number
    argpdot: number
    omgcof: number
    sinmao: number
    t: number
    t2cof: number
    t3cof: number
    t4cof: number
    t5cof: number
    x1mth2: number
    x7thm1: number
    mdot: number
    nodedot: number
    xlcof: number
    xmcof: number
    nodecf: number
    irez: number
    d2201: number
    d2211: number
    d3210: number
    d3222: number
    d4410: number
    d4422: number
    d5220: number
    d5232: number
    d5421: number
    d5433: number
    dedt: number
    del1: number
    del2: number
    del3: number
    didt: number
    dmdt: number
    dnodt: number
    domdt: number
    e3: number
    ee2: number
    peo: number
    pgho: number
    pho: number
    pinco: number
    plo: number
    se2: number
    se3: number
    sgh2: number
    sgh3: number
    sgh4: number
    sh2: number
    sh3: number
    si2: number
    si3: number
    sl2: number
    sl3: number
    sl4: number
    gsto: number
    xfact: number
    xgh2: number
    xgh3: number
    xgh4: number
    xh2: number
    xh3: number
    xi2: number
    xi3: number
    xl2: number
    xl3: number
    xl4: number
    xlamo: number
    zmol: number
    zmos: number
    atime: number
    xli: number
    xni: number
    a: number
    altp: number
    alta: number
    epochdays: number
    jdsatepoch: number
    nddot: number
    ndot: number
    bstar: number
    inclo: number
    nodeo: number
    ecco: number
    argpo: number
    mo: number
    no: number
    nokozai: number
    tempa: number
  }
}

declare module './satellite/io.js' {
  export function twoline2satrec(line1: string, line2: string): import('./satellite/propagation/SatRec.js').SatRec | null
  export function json2satrec(json: any): import('./satellite/propagation/SatRec.js').SatRec | null
}

declare module './satellite/transforms.js' {
  export function radiansToDegrees(radians: number): number
  export function degreesToRadians(degrees: number): number
  export function degreesLat(radians: number): number
  export function degreesLong(radians: number): number
  export function radiansLat(degrees: number): number
  export function radiansLong(degrees: number): number
  export function geodeticToEcf(params: { longitude: number; latitude: number; height: number }): { x: number; y: number; z: number }
  export function eciToGeodetic(eci: { x: number; y: number; z: number }, gmst: number): { longitude: number; latitude: number; height: number }
  export function eciToEcf(eci: { x: number; y: number; z: number }, gmst: number): { x: number; y: number; z: number }
  export function ecfToEci(ecf: { x: number; y: number; z: number }, gmst: number): { x: number; y: number; z: number }
  export function ecfToLookAngles(observer: { longitude: number; latitude: number; height: number }, satellite: { x: number; y: number; z: number }): any
}

declare module './satellite/common-types.js' {
  export type Degrees = number
  export type Radians = number
  export type Kilometer = number
  export type EciVec3<T> = { x: T; y: T; z: T }
  export type EcfVec3<T> = { x: T; y: T; z: T }
  export type GeodeticLocation = { longitude: number; latitude: number; height: number }
  export type GMSTime = number
  export type LookAngles = any
}

declare module './satellite/shadow.js' {
  export * from './satellite/shadow.js'
}

declare module './satellite/sun.js' {
  export function sunPos(date: Date): { x: number; y: number; z: number }
}

declare module './satellite/dopplerFactor.js' {
  export function dopplerFactor(velocity: { x: number; y: number; z: number }, position: { x: number; y: number; z: number }): number
}