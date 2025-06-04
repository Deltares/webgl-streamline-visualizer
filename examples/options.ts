import { StreamlineStyle } from '@/render'
import {
  TrailParticleShape,
  type StreamlineVisualiser,
  type StreamlineVisualiserOptions,
  type TrailParticleOptions
} from '@/visualiser'

import waveCrestUrl from './wave.svg'

export class VisualiserOptionsControl extends HTMLElement {
  private container: HTMLDivElement
  private visualiser: StreamlineVisualiser | null = null
  private onNumParticleChangeCallbacks: ((numParticles: number) => void)[] = []
  private onOptionsChangeCallbacks: ((
    options: Partial<StreamlineVisualiserOptions>
  ) => void)[] = []

  constructor() {
    super()
    this.container = document.createElement('div')
    this.container.style.display = 'flex'
    this.container.style.flexDirection = 'column'
    this.container.style.rowGap = '10px'
  }

  connectedCallback(): void {
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.appendChild(this.container)
  }

  attachVisualiser(visualiser: StreamlineVisualiser): void {
    this.visualiser = visualiser

    this.initialiseControls()
  }

  async setOptions(
    numParticles?: number,
    options?: Partial<StreamlineVisualiserOptions>
  ): Promise<void> {
    if (!this.visualiser) return
    if (numParticles) {
      this.visualiser.setNumParticles(numParticles)
      this.onNumParticleChangeCallbacks.forEach(callback =>
        callback(numParticles)
      )
    }
    if (options) {
      await this.visualiser.updateOptions(options)
      this.onOptionsChangeCallbacks.forEach(callback => callback(options))
    }
  }

  private initialiseControls() {
    const styleSelect = this.createStreamlineStyleSelectControl()
    const numParticlesControl = this.createNumParticlesControl()
    const particleSizeControl = this.createNumericOptionsControl(
      'Particle size [pixels]',
      'particleSize',
      1
    )
    const speedFactorControl = this.createNumericOptionsControl(
      'Speed factor',
      'speedFactor',
      0.1
    )
    const fadeAmountControl = this.createNumericOptionsControl(
      'Fade amount per second',
      'fadeAmountPerSecond',
      1
    )
    const maximumDisplacementControl = this.createNumericOptionsControl(
      'Maximum displacement [pixels]',
      'maxDisplacement',
      1
    )
    const maxAgeControl = this.createNumericOptionsControl(
      'Maximum particle age [s]',
      'maxAge',
      0.1,
      1
    )
    const speedExponentControl = this.createNumericOptionsControl(
      'Speed exponent',
      'speedExponent',
      0.1,
      1
    )
    const growthRateControl = this.createNumericOptionsControl(
      'Growth rate [particle sizes/s]',
      'growthRate',
      1,
      5
    )
    const aspectRatioControl = this.createTrailParticleAspectRatioControl()
    const trailParticleShapeControl =
      this.createTrailParticleShapeControl(aspectRatioControl)

    this.container.appendChild(styleSelect)
    this.container.appendChild(numParticlesControl)
    this.container.appendChild(particleSizeControl)
    this.container.appendChild(speedFactorControl)
    this.container.appendChild(fadeAmountControl)
    this.container.appendChild(maximumDisplacementControl)
    this.container.appendChild(maxAgeControl)
    this.container.appendChild(speedExponentControl)
    this.container.appendChild(growthRateControl)
    this.container.appendChild(trailParticleShapeControl)
    this.container.appendChild(aspectRatioControl)

    // Optionally show a checkbox allow wave crests to be turned on and off.
    const allowWaveCrest = this.getAttribute('allow-wave-crest') !== null
    if (allowWaveCrest) {
      const waveCrestControl = this.createWaveCrestControl(false)
      this.container.appendChild(waveCrestControl)
    }
  }

  private createStreamlineStyleSelectControl(): HTMLSelectElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const select = document.createElement('select')
    const options = [
      {
        title: 'Light particles on velocity magnitude',
        value: StreamlineStyle.LightParticlesOnMagnitude
      },
      {
        title: 'Dark particles on velocity magnitude',
        value: StreamlineStyle.DarkParticlesOnMagnitude
      },
      {
        title: 'Colored particles on velocity magnitude',
        value: StreamlineStyle.ColoredParticles
      },
      {
        title: 'Magnitude colored particles',
        value: StreamlineStyle.MagnitudeColoredParticles
      }
    ]
    options.forEach(option => {
      const el = document.createElement('option')
      el.value = option.value.toString()
      el.textContent = option.title

      select.appendChild(el)
    })

    select.value = this.visualiser.options.style.toString()
    select.addEventListener('input', () => {
      if (!this.visualiser) return
      const style = +select.value
      this.visualiser
        .updateOptions({ style })
        .catch(error =>
          console.error(`Failed to update visualiser options: ${error}`)
        )
    })

    this.onOptionsChangeCallbacks.push(options => {
      if (options.style) {
        select.value = options.style.toString()
      }
    })

    return select
  }

  private createTrailParticleShapeControl(
    aspectRatioControl: HTMLLabelElement
  ): HTMLSelectElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const select = document.createElement('select')
    const options = [
      {
        title: 'Circle',
        value: TrailParticleShape.Circle
      },
      {
        title: 'Rectangle',
        value: TrailParticleShape.Rectangle
      }
    ]
    options.forEach(option => {
      const el = document.createElement('option')
      el.value = option.value.toString()
      el.textContent = option.title

      select.appendChild(el)
    })

    select.value =
      this.visualiser.options.trailParticleOptions?.shape ??
      TrailParticleShape.Circle
    select.addEventListener('input', () => {
      if (!this.visualiser) return
      const shape = select.value as TrailParticleShape
      const aspectRatio =
        shape === TrailParticleShape.Circle
          ? undefined
          : this.visualiser.options.trailParticleOptions?.aspectRatio
      const trailParticleOptions: TrailParticleOptions = {
        aspectRatio,
        shape
      }
      this.visualiser
        .updateOptions({ trailParticleOptions })
        .catch(error =>
          console.error(`Failed to update visualiser options: ${error}`)
        )

      // Hide aspect ratio control if we use circles.
      if (shape === TrailParticleShape.Circle) {
        aspectRatioControl.style.display = 'none'
      } else {
        aspectRatioControl.style.display = 'flex'
      }
    })

    this.onOptionsChangeCallbacks.push(options => {
      if (options.trailParticleOptions?.shape) {
        select.value = options.trailParticleOptions?.shape
      }
    })

    return select
  }

  private createTrailParticleAspectRatioControl(): HTMLLabelElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const setOption = (value: number) => {
      if (!this.visualiser) return
      const trailParticleOptions: TrailParticleOptions = {
        shape:
          this.visualiser.options.trailParticleOptions?.shape ??
          TrailParticleShape.Circle,
        aspectRatio: value
      }
      this.visualiser
        .updateOptions({ trailParticleOptions })
        .catch(error =>
          console.error(`Failed to update visualiser options: ${error}`)
        )
    }
    const [labelElement, inputElement] = this.createNumericInput(
      'Trail particle aspect ratio',
      this.visualiser.options.trailParticleOptions?.aspectRatio ?? 1,
      0.1,
      setOption
    )

    this.onOptionsChangeCallbacks.push(options => {
      const aspectRatio = options.trailParticleOptions?.aspectRatio ?? 1
      inputElement.value = aspectRatio.toString()
    })

    // Hide the control if we use circles.
    const shape =
      this.visualiser.options.trailParticleOptions?.shape ??
      TrailParticleShape.Circle
    if (shape === TrailParticleShape.Circle) {
      labelElement.style.display = 'none'
    }

    return labelElement
  }

  private createNumParticlesControl(): HTMLLabelElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const setNumParticles = (numParticles: number) => {
      if (!this.visualiser) return
      this.visualiser.setNumParticles(numParticles)
    }
    const [labelElement, inputElement] = this.createNumericInput(
      'Number of particles',
      this.visualiser.numParticles,
      1000,
      setNumParticles
    )

    this.onNumParticleChangeCallbacks.push(numParticles => {
      inputElement.value = numParticles.toString()
    })

    return labelElement
  }

  private createNumericOptionsControl(
    label: string,
    key: keyof Omit<
      StreamlineVisualiserOptions,
      'style' | 'particleColor' | 'spriteUrl' | 'trailParticleOptions'
    >,
    step: number,
    defaultValue: number = 0
  ): HTMLLabelElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const setOption = (value: number) => {
      if (!this.visualiser) return
      this.visualiser
        .updateOptions({ [key]: value })
        .catch(error =>
          console.error(`Failed to update visualiser options: ${error}`)
        )
    }
    const [labelElement, inputElement] = this.createNumericInput(
      label,
      this.visualiser.options[key] ?? defaultValue,
      step,
      setOption
    )

    this.onOptionsChangeCallbacks.push(options => {
      const option = options[key]
      if (option !== undefined) {
        inputElement.value = options[key]!.toString()
      }
    })

    return labelElement
  }

  private createWaveCrestControl(initialValue: boolean): HTMLLabelElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const el = document.createElement('label')
    el.textContent = 'Use wave crest particles'
    el.style.display = 'flex'
    el.style.justifyContent = 'space-between'
    el.style.columnGap = '10px'

    const input = document.createElement('input')
    input.type = 'checkbox'
    input.checked = initialValue

    input.addEventListener('input', () => {
      if (!this.visualiser) return
      this.visualiser
        .updateOptions({
          spriteUrl: input.checked ? new URL(waveCrestUrl) : undefined
        })
        .catch(error =>
          console.error(`Failed to update visualiser options: ${error}`)
        )
    })

    this.onOptionsChangeCallbacks.push(options => {
      const useWaveCrests = options.spriteUrl !== undefined
      input.checked = useWaveCrests
    })

    el.appendChild(input)
    return el
  }

  private createNumericInput(
    label: string,
    initialValue: number,
    step: number,
    callback: (value: number) => void
  ): [HTMLLabelElement, HTMLInputElement] {
    const el = document.createElement('label')
    el.textContent = label
    el.style.display = 'flex'
    el.style.justifyContent = 'space-between'
    el.style.columnGap = '10px'

    const input = document.createElement('input')
    input.type = 'number'
    input.step = step.toString()

    input.value = initialValue.toString()
    input.addEventListener('input', () =>
      this.setNumberIfValid(input.value, callback)
    )

    el.appendChild(input)
    return [el, input]
  }

  private setNumberIfValid(
    value: string,
    callback: (value: number) => void
  ): void {
    const numericValue = parseFloat(value)
    if (isNaN(numericValue)) return
    callback(numericValue)
  }
}

customElements.define('visualiser-options-control', VisualiserOptionsControl)
