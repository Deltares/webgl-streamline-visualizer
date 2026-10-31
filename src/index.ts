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
