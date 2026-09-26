/**
 * Commercial entitlement and technical availability are different facts.
 *
 * A projection saying the customer owns a feature does not turn on a feature
 * the CMS has switched off. A local row cannot grant a feature the projection
 * did not. A technical hold disables one site without rewriting the projection.
 */

export type FeatureLayer = 'projection' | 'technical' | 'technical-hold'

export type EffectiveFeature = {
  commerciallyEntitled: boolean
  enabled: boolean
  key: string
  label: string
  layer: FeatureLayer | 'legacy'
  technicallyAvailable: boolean
}

export const applyTechnicalGate = (args: {
  catalogue: { key: string; label?: null | string; technicallyAvailable?: boolean }[]
  commercial: Record<string, boolean>
  holds: string[]
}): EffectiveFeature[] => {
  const held = new Set(args.holds.filter(Boolean))
  const features: EffectiveFeature[] = []
  const seen = new Set<string>()

  for (const entry of args.catalogue) {
    if (!entry.key) continue
    seen.add(entry.key)
    const technicallyAvailable = entry.technicallyAvailable !== false
    const commerciallyEntitled = args.commercial[entry.key] === true
    const onHold = held.has(entry.key)
    const layer: FeatureLayer = onHold ? 'technical-hold' : !technicallyAvailable ? 'technical' : 'projection'
    features.push({
      commerciallyEntitled,
      enabled: technicallyAvailable && commerciallyEntitled && !onHold,
      key: entry.key,
      label: entry.label?.trim() || entry.key,
      layer,
      technicallyAvailable,
    })
  }

  for (const [key, entitled] of Object.entries(args.commercial)) {
    if (!key || seen.has(key)) continue
    const onHold = held.has(key)
    features.push({
      commerciallyEntitled: entitled === true,
      enabled: entitled === true && !onHold,
      key,
      label: key,
      layer: onHold ? 'technical-hold' : 'projection',
      technicallyAvailable: true,
    })
  }

  return features.sort((a, b) => a.key.localeCompare(b.key))
}
