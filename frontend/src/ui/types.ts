/** A display category (backend category_id 1-7) with its data colour. */
export interface CategoryInfo {
  readonly id: number
  readonly name: string
  readonly color: string
}

/** An external link shown in the details panel (validated to http/https before rendering). */
export interface MediaLink {
  readonly label: string
  readonly url: string
}
