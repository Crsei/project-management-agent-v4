import type { FixtureHandle } from '../schemas/types.ts';
import { writeRootedFile } from '../isolation/filesystem.ts';
import { PARTIAL_RETRY_SOURCE, PARTIAL_RETRY_TEST } from '../tasks/guidance.ts';

/** Scenario inputs precede the before-snapshot and are identical for all arms of the task. */
export async function prepareGuidanceScenario(taskId: string, fixture: FixtureHandle): Promise<void> {
  if (taskId !== 'D04') return;
  await writeRootedFile(fixture.publicRoot, 'repo/src/retry.ts', PARTIAL_RETRY_SOURCE);
  await writeRootedFile(fixture.publicRoot, 'repo/test/retry-partial.test.ts', PARTIAL_RETRY_TEST, { createParents: true, exclusive: true });
}

