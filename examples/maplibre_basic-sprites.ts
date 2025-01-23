import './maplibre_basic.css'
import 'maplibre-gl/dist/maplibre-gl.css'
import spriteUrl from './wave.svg'

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
  baseUrl:
    'https://rwsos-dataservices-ont.avi.deltares.nl/durban/FewsWebServices/wms',
  layer: 'swan_hs',
  streamlineStyle: StreamlineStyle.LightParticlesOnMagnitude,
  numParticles: 1000,
  particleSize: 16,
  speedFactor: 0.1,
  fadeAmountPerSecond: 3,
  speedExponent: 0.7,
  spriteUrl: new URL(spriteUrl, window.location.origin)
}

const layer = new WMSStreamlineLayer('streamlines', options)
map.addLayer(layer)

await layer.initialise()
