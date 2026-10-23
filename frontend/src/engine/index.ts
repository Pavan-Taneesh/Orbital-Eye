/* ============================================================
   Orbital Eye engine: public API for the integrator.
   ------------------------------------------------------------
   Data
     loadCatalog({ signal?, onUpdate? }): Promise<LoadedCatalog>
       Stale-while-revalidate from IndexedDB ("orbital-eye"/"catalog").
       Resolves instantly from cache when present (fromCache: true) and
       revalidates in the background with If-None-Match; onUpdate(newCatalog)
       fires only when the server has a newer version. objects[i] and omm[i]
       are index-aligned; byId / byNorad map to that index. All frozen.
       NOTE: indices change between catalog versions; on onUpdate dispose the
       old Propagator and build a new one from the new catalog.
     getObjectDetails(id): Promise<ObjectDetails>
       api.get() behind a 7-day IndexedDB cache + in-flight dedupe.

   Positions (all positions are REAL SGP4 from the OMM elements)
     const prop = new Propagator(catalog.omm, { tickHz: lowEnd ? 4 : 8 })
     every frame (useFrame):
       const t = clock.now()
       prop.setTime(t)
       if (prop.writePositions(positionsAttr.array, t)) positionsAttr.needsUpdate = true
       earthGroup.rotation.y = earthRotationY(t)
       sunLight.position.set(...sunDirectionScene(t)).multiplyScalar(50)
     prop.getLiveState(index, t)  -> exact altitude/speed/lat/lon + scene position
     prop.getOrbitPath(index, t, 180) -> one revolution, scene coords (draw as LineLoop)
     prop.getGroundTrack(index, t, 180) -> lat/lon pairs (deg)
     prop.dispose() on unmount.
     prop.status: 'loading' | 'ready' | 'failed'; onError(message) fires once on
     failure (worker failed to load/crashed/catalog init failed) -> show an error.
     writePositions writes NaN for objects that cannot be propagated (bad
     elements, decayed): give the Points/Instanced geometry a fixed
     boundingSphere (or frustumCulled = false), or pass invalidFill: 'origin'.

   Frames: scene is Y-up. TEME/ECI km (x, y, z) -> scene (x, z, -y) * 2.2/6371.
     The scene is inertial; the Earth mesh spins by earthRotationY(t) (GMST).

   Time
     const clock = createSimClock()  // starts live
     clock.now(), clock.state (TimeState), setWarp(w), play(), pause(),
     goLive(), seek(ms), subscribe(fn) -> unsubscribe, dispose(). WARP_PRESETS.
     state.live is true only while following wall-clock time (goLive()).
   ============================================================ */

export type * from './contract'
export {
  loadCatalog,
  getObjectDetails,
  orbitShape,
  type LoadedCatalog,
  type LoadCatalogOptions,
  type OmmRecord,
} from './catalogStore'
export {
  Propagator,
  type PropagatorOptions,
  type PropagatorStatus,
  type LiveStateDetailed,
} from './propagator'
export {
  EARTH_RADIUS_SCENE,
  EARTH_RADIUS_KM,
  SCENE_UNITS_PER_KM,
  earthRotationY,
  eciKmToScene,
  gmst,
  julianDate,
} from './frames'
export { createSimClock, WARP_PRESETS, type SimClock } from './clock'
export { sunDirectionScene, sunDirectionEci } from './sun'
export type { OmmInput } from './workerProtocol'
