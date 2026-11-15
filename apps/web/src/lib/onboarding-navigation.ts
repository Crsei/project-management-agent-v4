/** Only the PM guide is a valid return target; never accept an arbitrary URL. */
export function onboardingReturnTo(search: string): string | null {
  const value = new URLSearchParams(search).get("setupReturnTo")
  return value && /^\/pm\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/onboarding$/i.test(value) ? value : null
}

export function onboardingProviderUrl(returnTo: string): string {
  const search = new URLSearchParams({ setupReturnTo: returnTo }).toString()
  return onboardingReturnTo(search) ? `/agent/settings/providers?${search}` : "/agent/settings/providers"
}
