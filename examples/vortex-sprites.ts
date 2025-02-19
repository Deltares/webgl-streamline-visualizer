import './vortex.css'
import spriteUrl from './wave.svg'

import { initialiseControl, initialiseVisualiser } from './vortex-base'
import { StreamlineStyle, type StreamlineVisualiserOptions } from '@/index'

const numParticles = 500
const options: StreamlineVisualiserOptions = {
  style: StreamlineStyle.LightParticlesOnMagnitude,
  particleSize: 24,
  speedFactor: 0.4,
  fadeAmountPerSecond: 3,
  maxDisplacement: 1,
  maxAge: 2,
  growthRate: 1,
  spriteUrl: new URL(spriteUrl, window.location.origin)
}

initialiseVisualiser(numParticles, options)
  .then(visualiser => {
    initialiseControl(visualiser)
  })
  .catch(error => console.error(`Failed to initialise visualiser: ${error}`))
