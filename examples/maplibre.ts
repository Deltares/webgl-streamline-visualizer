import './maplibre.css'
import 'maplibre-gl/dist/maplibre-gl.css'

import { Map } from 'maplibre-gl'

import type { WMSStreamlineLayerOptions } from '@/layer'
import { StreamlineStyle, WMSStreamlineLayer } from '@/index'

import { VisualiserOptionsControl } from './options'
import './wms.ts'
import type { FewsWmsOptionsControl } from './wms.ts'

async function createMap(): Promise<Map> {
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
    if (!layer.visualiser) {
      throw new Error('Streamline visualiser was not initialised.')
    }

    const layerControl = document.getElementById(
      'wms-control'
    ) as FewsWmsOptionsControl
    layerControl.attachLayer(layer)

    // Initialise visualiser options control.
    const optionsControl = document.getElementById(
      'options-control'
    ) as VisualiserOptionsControl
    optionsControl.attachVisualiser(layer.visualiser)
  })
  return layer
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
