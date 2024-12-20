import { StreamlineStyle } from '@/render'
import type {
  StreamlineVisualiser,
  StreamlineVisualiserOptions
} from '@/visualiser'

export class VisualiserOptionsControl extends HTMLElement {
  private container: HTMLDivElement
  private visualiser: StreamlineVisualiser | null = null

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
    const speedExponentControl = this.createNumericOptionsControl(
      'Speed exponent',
      'speedExponent',
      0.1,
      1
    )

    this.container.appendChild(styleSelect)
    this.container.appendChild(numParticlesControl)
    this.container.appendChild(particleSizeControl)
    this.container.appendChild(speedFactorControl)
    this.container.appendChild(fadeAmountControl)
    this.container.appendChild(maximumDisplacementControl)
    this.container.appendChild(speedExponentControl)
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
        value: StreamlineStyle.MagnitudeColoredParticles
      },
      {
        title: 'Magnitude colored particles',
        value: StreamlineStyle.ColoredParticles
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

    return select
  }

  private createNumParticlesControl(): HTMLLabelElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const setNumParticles = (numParticles: number) => {
      if (!this.visualiser) return
      this.visualiser.setNumParticles(numParticles)
      // Set the number of eliminated particles per second to the number of
      // particles; this works well in almost all cases.
      this.visualiser.updateOptions({ numEliminatePerSecond: numParticles })
    }
    return this.createNumericInput(
      'Number of particles',
      this.visualiser.numParticles,
      1000,
      setNumParticles
    )
  }

  private createNumericOptionsControl(
    label: string,
    key: keyof Omit<StreamlineVisualiserOptions, 'style' | 'particleColor'>,
    step: number,
    defaultValue: number = 0
  ): HTMLLabelElement {
    if (!this.visualiser) throw new Error('No attached visualiser.')

    const setOption = (value: number) => {
      if (!this.visualiser) return
      this.visualiser.updateOptions({ [key]: value })
    }
    return this.createNumericInput(
      label,
      this.visualiser.options[key] ?? defaultValue,
      step,
      setOption
    )
  }

  private createNumericInput(
    label: string,
    initialValue: number,
    step: number,
    callback: (value: number) => void
  ): HTMLLabelElement {
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
    return el
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
