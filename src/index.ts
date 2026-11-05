export { WMSStreamlineLayer, type WMSStreamlineLayerOptions } from './layer'
export { StreamlineStyle } from './render'
export {
  StreamlineVisualiser,
  TrailParticleShape,
  type TrailParticleOptions,
  type StreamlineVisualiserOptions
} from './visualiser'
export {
  fetchWMSAvailableTimesAndElevations,
  fetchWMSColormap,
  fetchWMSVelocityField,
  type WMSVelocityFieldOptions
} from './utils/wms'
export { type BoundingBoxScaling } from './render/final'
export { Color, Colormap } from './utils/colormap'
export { VelocityImage } from './utils/velocity-image'
export {
  RegularVelocityChunk,
  MISSING_FLOAT_SENTINEL,
  type RegularGrid,
  type RegularGridCrs
} from './geographic/regular-velocity-chunk'
export {
  CurvilinearGrid,
  CurvilinearVelocityField,
  type CurvilinearGridOptions,
  type CurvilinearLocation
} from './geographic/curvilinear-velocity-field'
export {
  NestedVelocityField,
  MAX_NESTED_FIELDS,
  type SingleVelocityField,
  type VelocityField
} from './geographic/velocity-field'
export {
  GeographicStreamlineLayer,
  type GeographicStreamlineLayerOptions
} from './geographic/layer'
export {
  GeographicStreamlineVisualiser,
  type GeographicView,
  type SpawnTable
} from './geographic/visualiser'
export {
  type ProjectionShaderData,
  type ProjectionUniformData
} from './geographic/programs'
