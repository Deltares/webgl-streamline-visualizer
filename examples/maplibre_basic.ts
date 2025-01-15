import './maplibre_basic.css'
import 'maplibre-gl/dist/maplibre-gl.css'

import { Map } from 'maplibre-gl'
import {
  StreamlineStyle,
  WMSStreamlineLayer,
  type WMSStreamlineLayerOptions
} from '@/index'

const defaultCentre: [number, number] = [0, 0]
const defaultZoom = 0.2
const style = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
const map = new Map({
  container: 'container',
  style,
  center: defaultCentre,
  zoom: defaultZoom
})

await map.once('load')

const options: WMSStreamlineLayerOptions = {
  baseUrl: 'https://example.com/FewsWebServices/wms',
  layer: 'layer_name',
  streamlineStyle: StreamlineStyle.LightParticlesOnMagnitude,
  numParticles: 12000,
  particleSize: 4,
  speedFactor: 0.1,
  fadeAmountPerSecond: 3,
  speedExponent: 0.7
}

const layer = new WMSStreamlineLayer('streamlines', options)
map.addLayer(layer)

await layer.initialise()
