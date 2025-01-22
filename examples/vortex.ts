import './vortex.css'

import { initialiseControl, initialiseVisualiser } from './vortex-base'
import { StreamlineStyle, type StreamlineVisualiserOptions } from '@/index'

const numParticles = 10000
const options: StreamlineVisualiserOptions = {
  style: StreamlineStyle.LightParticlesOnMagnitude,
  numEliminatePerSecond: numParticles,
  particleSize: 3,
  speedFactor: 0.4,
  fadeAmountPerSecond: 3,
  maxDisplacement: 1
}

initialiseVisualiser(numParticles, options)
  .then(visualiser => {
    initialiseControl(visualiser)
  })
  .catch(error => console.error(`Failed to initialise visualiser: ${error}`))
