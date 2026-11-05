export function pmAnalysisProviderSupport(driver: string): { available: boolean; reason: string | null } {
  return driver === 'claude' ? { available: true, reason: null } : { available: false, reason: `Provider ${driver} has no verified native no-tools analysis transport. Select an enabled Claude Provider; a read-only sandbox alone does not disable code execution.` };
}
