import './vortex.css'
import spriteUrl from './wave.svg'

import { initialiseControl, initialiseVisualiser } from './vortex-base'
import { StreamlineStyle, type StreamlineVisualiserOptions } from '@/index'

const numParticles = 100
const options: StreamlineVisualiserOptions = {
  style: StreamlineStyle.LightParticlesOnMagnitude,
  numEliminatePerSecond: numParticles,
  particleSize: 16,
  speedFactor: 0.4,
  fadeAmountPerSecond: 1,
  maxDisplacement: 1,
  spriteUrl: new URL(spriteUrl, window.location.origin)
}

initialiseVisualiser(numParticles, options)
  .then(visualiser => {
    initialiseControl(visualiser)
  })
  .catch(error => console.error(`Failed to initialise visualiser: ${error}`))
