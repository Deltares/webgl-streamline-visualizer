import './maplibre.css'
import 'maplibre-gl/dist/maplibre-gl.css'

import { Map } from 'maplibre-gl'

import type { WMSStreamlineLayerOptions } from '@/layer'
import { StreamlineStyle, WMSStreamlineLayer } from '@/index'

import { VisualiserOptionsControl } from './options'

async function createMap(): Promise<Map> {
  const defaultCentre: [number, number] = [5, 52]
  const defaultZoom = 5.5
  const style = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json'
  const map = new Map({
    container: 'container',
    style,
    center: defaultCentre,
    zoom: defaultZoom
  })

  await map.once('load')
  return map
}

function createStreamlinesLayer(): WMSStreamlineLayer {
  const baseUrl =
    'https://rwsos-dataservices-ont.avi.deltares.nl/durban/FewsWebServices/wms'
  const layerName = 'kzn_z_currents_d3d'
  const options: WMSStreamlineLayerOptions = {
    baseUrl,
    layer: layerName,
    streamlineStyle: StreamlineStyle.LightParticlesOnMagnitude,
    numParticles: 12000,
    particleSize: 4,
    speedFactor: 0.1,
    fadeAmountPerSecond: 3,
    speedExponent: 0.7
  }

  const layer = new WMSStreamlineLayer('streamlines', options)
  // Add event listener to initialise the layer once it has been added to the
  // map.
  layer.once('add', () => {
    initialiseLayer(layer).catch(error =>
      console.error(
        `Failed to initialise streamlines layer: ${(error as Error).toString()}.`
      )
    )
  })
  return layer
}

async function initialiseLayer(layer: WMSStreamlineLayer): Promise<void> {
  const time = new Date('2024-12-20T12:00:00Z')
  const elevation = -0.5
  await layer.initialise(time, elevation)

  if (!layer.visualiser) {
    throw new Error('Streamline visualiser was not initialised.')
  }

  // Initialise visualiser options control.
  const control = document.getElementById(
    'options-control'
  ) as VisualiserOptionsControl
  control.attachVisualiser(layer.visualiser)
}

function initialise(): void {
  const layer = createStreamlinesLayer()
  createMap()
    .then(map => map.addLayer(layer))
    .catch(error =>
      console.error(`Failed to create map: ${(error as Error).toString()}`)
    )
}

initialise()
