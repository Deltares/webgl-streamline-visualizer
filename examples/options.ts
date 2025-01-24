import { StreamlineStyle } from '@/render'
import type {
  StreamlineVisualiser,
  StreamlineVisualiserOptions
} from '@/visualiser'

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

  setOptions(
    numParticles?: number,
    options?: Partial<StreamlineVisualiserOptions>
  ): void {
    if (!this.visualiser) return
    if (numParticles) {
      this.visualiser.setNumParticles(numParticles)
      this.onNumParticleChangeCallbacks.forEach(callback =>
        callback(numParticles)
      )
    }
    if (options) {
      this.visualiser.updateOptions(options)
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
      'Growth rate [pixels/s]',
      'growthRate',
      1,
      5
    )

    this.container.appendChild(styleSelect)
    this.container.appendChild(numParticlesControl)
    this.container.appendChild(particleSizeControl)
    this.container.appendChild(speedFactorControl)
    this.container.appendChild(fadeAmountControl)
    this.container.appendChild(maximumDisplacementControl)
    this.container.appendChild(maxAgeControl)
    this.container.appendChild(speedExponentControl)
    this.container.appendChild(growthRateControl)
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
      this.visualiser.updateOptions({ style })
    })

    this.onOptionsChangeCallbacks.push(options => {
      if (options.style) {
        select.value = options.style.toString()
      }
    })

    return select
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
      'style' | 'particleColor' | 'spriteUrl'
    >,
    step: number,
    defaultValue: number = 0
  ): HTMLLabelElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const setOption = (value: number) => {
      if (!this.visualiser) return
      this.visualiser.updateOptions({ [key]: value })
    }
    const [labelElement, inputElement] = this.createNumericInput(
      label,
      this.visualiser.options[key] ?? defaultValue,
      step,
      setOption
    )

    this.onOptionsChangeCallbacks.push(options => {
      if (key in options) {
        inputElement.value = options[key]!.toString()
      }
    })

    return labelElement
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
