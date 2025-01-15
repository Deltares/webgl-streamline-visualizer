import type { WMSStreamlineLayer } from '@/layer'
import { StreamlineStyle } from '@/render'
import type { StreamlineVisualiserOptions } from '@/visualiser'
import type {
  GetCapabilitiesResponse,
  Layer as FewsWmsLayer
} from '@deltares/fews-wms-requests'

interface WmsStyle {
  id: string
  title: string
}

type FewsAnimatedVectorSettings = FewsWmsLayer['animatedVectors']
interface Layer {
  id: string
  title: string
  times: Date[]
  styles: WmsStyle[]
  elevationBounds: [number, number] | null
  defaultSettings: FewsAnimatedVectorSettings
}

type LayerChangeCallback = (
  numParticles?: number,
  options?: Partial<StreamlineVisualiserOptions>
) => void

export class FewsWmsOptionsControl extends HTMLElement {
  private layer: WMSStreamlineLayer | null
  private availableLayers: Layer[]
  private layerChangeCallback: LayerChangeCallback | null

  private container: HTMLDivElement
  private controlContainer: HTMLDivElement

  private baseUrlInput: HTMLInputElement
  private layerSelect: HTMLSelectElement
  private styleSelect: HTMLSelectElement
  private timeSelect: HTMLSelectElement
  private elevationInput: HTMLInputElement

  constructor() {
    super()

    this.layer = null
    this.availableLayers = []
    this.layerChangeCallback = null

    this.container = document.createElement('div')
    this.container.style.display = 'flex'
    this.container.style.flexDirection = 'column'
    this.container.style.rowGap = '10px'

    const [baseUrlLabel, baseUrlInput] = this.createBaseUrlControl()
    this.baseUrlInput = baseUrlInput

    this.container.appendChild(baseUrlLabel)

    this.controlContainer = document.createElement('div')
    this.controlContainer.style.width = '100%'
    this.controlContainer.style.display = 'flex'
    this.controlContainer.style.columnGap = '10px'

    this.layerSelect = this.createSelectControl('Select WMS layer')
    this.layerSelect.addEventListener('input', () => this.selectLayer())

    this.styleSelect = this.createSelectControl('Select style')
    this.styleSelect.addEventListener('input', () => this.selectStyle())

    this.timeSelect = this.createSelectControl('Select time')
    this.timeSelect.addEventListener('input', () => this.selectTime())

    const [elevationLabel, elevationInput] = this.createElevationInput()
    this.elevationInput = elevationInput
    this.elevationInput.addEventListener('input', () => this.selectElevation())

    this.controlContainer.appendChild(this.layerSelect)
    this.controlContainer.appendChild(this.styleSelect)
    this.controlContainer.appendChild(this.timeSelect)
    this.controlContainer.appendChild(elevationLabel)

    this.container.appendChild(this.controlContainer)
  }

  connectedCallback(): void {
    const shadow = this.attachShadow({ mode: 'open' })
    shadow.appendChild(this.container)
  }

  attachLayer(layer: WMSStreamlineLayer): void {
    this.layer = layer
  }

  onLayerChange(callback: LayerChangeCallback): void {
    this.layerChangeCallback = callback
  }

  private createSelectControl(placeholder: string): HTMLSelectElement {
    const el = document.createElement('select')
    el.disabled = true
    el.setAttribute('data-placeholder', placeholder)

    const placeholderOption = document.createElement('option')
    placeholderOption.textContent = placeholder

    el.appendChild(placeholderOption)
    return el
  }

  private createElevationInput(): [HTMLLabelElement, HTMLInputElement] {
    const el = document.createElement('label')

    const input = document.createElement('input')
    input.type = 'number'
    input.step = '100'
    input.disabled = true

    el.appendChild(input)
    return [el, input]
  }

  private createBaseUrlControl(): [HTMLLabelElement, HTMLInputElement] {
    const el = document.createElement('label')
    el.style.display = 'flex'
    el.style.flexDirection = 'column'
    el.textContent =
      'FEWS WMS service URL (e.g. https://example.com/FewsWebServices/wms):'

    const input = document.createElement('input')
    input.type = 'text'
    input.addEventListener('input', () => {
      this.setBaseUrl(input.value).catch(() =>
        console.error('Error when setting base URL.')
      )
    })

    el.appendChild(input)
    return [el, input]
  }

  private async setBaseUrl(baseUrl: string): Promise<void> {
    // Try a version request to see whether this is a valid WMS url.
    try {
      const url = new URL(baseUrl)
      url.searchParams.append('request', 'GetVersion')
      await fetch(url)

      // We have a working WMS URL, so fetch times, elevation and styles.
      await this.fetchCapabilities(baseUrl)
      this.createWmsLayerOptions()
    } catch {
      this.disableControls()
      return
    }
  }

  private async fetchCapabilities(baseUrl: string): Promise<void> {
    const url = new URL(baseUrl)
    url.searchParams.append('request', 'GetCapabilities')
    url.searchParams.append('format', 'application/json')

    const response = await fetch(url)
    const data = (await response.json()) as GetCapabilitiesResponse

    // Find layers configured to use animated vectors.
    const usableLayers = data.layers.filter(
      layer => layer.animatedVectors !== undefined
    )
    this.availableLayers = usableLayers.map(layer => {
      const times = layer.times?.map(time => new Date(time)) ?? []
      const styles: WmsStyle[] =
        layer.styles?.map(style => ({
          id: style.name!, // FIXME: why can "name" be undefined?
          title: style.title
        })) ?? []
      let elevationBounds: [number, number] | null = null
      if (layer.elevation?.lowerValue && layer.elevation.upperValue) {
        elevationBounds = [
          layer.elevation.lowerValue,
          layer.elevation.upperValue
        ]
      }
      return {
        id: layer.name,
        title: layer.title,
        times,
        styles,
        elevationBounds,
        defaultSettings: layer.animatedVectors!
      }
    })
  }

  private createWmsLayerOptions(): void {
    // Remove all previous options.
    this.layerSelect.innerHTML = ''

    // Add an option for each layer.
    this.availableLayers.forEach(layer => {
      const option = document.createElement('option')
      option.textContent = layer.title
      option.value = layer.id

      this.layerSelect.appendChild(option)
    })

    // Enable the control.
    this.layerSelect.disabled = false

    // Call selectLayer for the currently selected first option.
    this.selectLayer()
  }

  private selectLayer(): void {
    if (!this.layer) throw new Error('No attached layer.')

    const layer = this.availableLayers.find(
      layer => layer.id === this.layerSelect.value
    )
    if (!layer) {
      throw new Error(`Invalid selected layer ID "${this.layerSelect.value}".`)
    }

    // Recreate style options.
    this.styleSelect.innerHTML = ''
    layer.styles.forEach(style => {
      const option = document.createElement('option')
      option.textContent = style.title
      option.value = style.id

      this.styleSelect.appendChild(option)
    })
    this.styleSelect.disabled = layer.styles.length < 2

    // Recreate time options.
    this.timeSelect.innerHTML = ''
    layer.times.forEach(time => {
      const option = document.createElement('option')
      option.textContent = time.toLocaleString()
      option.value = time.getTime().toString()

      this.timeSelect.appendChild(option)
    })
    this.timeSelect.disabled = layer.times.length < 2

    // Set elevation input bounds (or disabled it altogether).
    if (layer.elevationBounds) {
      this.elevationInput.disabled = false
      this.elevationInput.min = layer.elevationBounds[0].toString()
      this.elevationInput.max = layer.elevationBounds[1].toString()
      // Always set it to the highest value.
      this.elevationInput.value = layer.elevationBounds[1].toString()
    } else {
      this.elevationInput.value = ''
      this.elevationInput.disabled = true
    }

    // Initialise layer.
    this.layer
      .setWmsLayer(this.baseUrlInput.value, this.layerSelect.value)
      .then(() => {
        if (this.layerChangeCallback) {
          const fewsOptions = layer.defaultSettings
          const options: Partial<StreamlineVisualiserOptions> = {
            style: fewsOptions?.coloredParticles
              ? StreamlineStyle.MagnitudeColoredParticles
              : StreamlineStyle.ColoredParticles,
            particleSize: fewsOptions?.particleSize,
            speedFactor: fewsOptions?.speedFactor,
            fadeAmountPerSecond: fewsOptions?.fadeAmount,
            speedExponent: fewsOptions?.speedExponent,
            particleColor: fewsOptions?.particleColor
              ? `#${fewsOptions?.particleColor}`
              : undefined
          }
          const numParticles = fewsOptions?.numberOfParticles

          try {
            this.layerChangeCallback(numParticles, options)
          } catch (error) {
            console.error(
              `Layer change callback failed: ${(error as Error).toString()}`
            )
          }
        }
      })
      .catch(error =>
        console.error(
          `Failed to initialise streamlines layer: ${(error as Error).toString()}`
        )
      )
  }

  private selectStyle(): void {
    if (!this.layer) throw new Error('No attached layer.')

    this.layer
      .setStyle(this.styleSelect.value)
      .catch(error =>
        console.error(`Failed to set WMS style: ${(error as Error).toString()}`)
      )
  }

  private selectTime(): void {
    if (!this.layer) throw new Error('No attached layer.')

    const date = new Date(+this.timeSelect.value)
    this.layer
      .setTime(date)
      .catch(error =>
        console.error(`Failed to set WMS time: ${(error as Error).toString()}`)
      )
  }

  private selectElevation(): void {
    if (!this.layer) throw new Error('No attached layer.')

    const elevation = parseFloat(this.elevationInput.value)
    if (isNaN(elevation)) return

    this.layer
      .setElevation(elevation)
      .catch(error =>
        console.error(
          `Failed to set WMS elevation: ${(error as Error).toString()}`
        )
      )
  }

  private disableControls(): void {
    const restorePlaceholder = (el: HTMLSelectElement) => {
      el.innerHTML = `<option>${el.getAttribute('data-placeholder')}</option>`
    }
    restorePlaceholder(this.layerSelect)
    restorePlaceholder(this.styleSelect)
    restorePlaceholder(this.timeSelect)

    this.layerSelect.disabled = true
    this.styleSelect.disabled = true
    this.timeSelect.disabled = true

    this.elevationInput.value = ''
    this.elevationInput.disabled = true
  }
}

customElements.define('wms-options-control', FewsWmsOptionsControl)
