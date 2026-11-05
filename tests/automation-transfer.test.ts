import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { describe, it } from 'node:test';
import { decodeAutomationTar, exportAutomationDefinition, parseAutomationTransfer } from '../packages/application/src/automation-transfer.ts';
import { createConfiguredAutomationGitPort, decryptAutomationGitDocument, encryptAutomationGitDocument } from '../packages/infrastructure/src/automation-git.ts';
import { studioConfigSchema, studioNativeTemplateIdSchema, studioNativeTemplateRequiresProvider, type StudioDefinition } from '../packages/contracts/src/automation-studio.ts';
import { isPmAutomationTemplateId, pmAutomationTemplateVersion } from '../packages/contracts/src/automation-pm.ts';
import { pmAutomationDefaultArguments } from '../packages/automation-resources/pm-catalog.ts'

const config = studioConfigSchema.parse({ name: 'Portable definition', description: '', projectId: 'PRJ-001', tags: [], templateId: null, action: { kind: 'prompt', providerInstanceId: 'configured-provider', model: 'configured-model', options: {}, prompt: 'Read authorized inputs only', repositories: [], plugins: [], timeoutSeconds: 600 }, trigger: { kind: 'cron', expression: '0 9 * * 1-5', timezone: 'Asia/Shanghai' }, dailyLimit: 10, cooldownMinutes: 0 });
const definition: StudioDefinition = { id: '00000000-0000-4000-a000-000000000001', revision: 1, config, status: 'enabled', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', lastRunAt: null, nextDueAt: null };
function tar(path: string, content: string, type = '0'): string {
  const header = Buffer.alloc(512), body = Buffer.from(content);
  header.write(path, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257);
  const checksum = header.reduce((sum, value) => sum + value, 0); header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
  return gzipSync(Buffer.concat([header, body, Buffer.alloc((512 - body.length % 512) % 512), Buffer.alloc(1024)])).toString('base64');
}
describe('automation transfer safety', () => {
  it('round trips every supported full bundle config field without activation state', () => {
    const script = studioConfigSchema.parse({ ...config, tags: ['retained'], description: 'retained', action: { kind: 'script', entrypoint: 'python main.py', content: 'print(1)', setup: '', bundleRef: 'upload-provenance', files: [{ path: 'main.py', content: 'print(1)' }, { path: 'data.json', content: '{"real":true}' }], repositories: [], plugins: [], timeoutSeconds: 60 } });
    const exported = exportAutomationDefinition({ ...definition, config: script }, 'bundle');
    assert.deepEqual(parseAutomationTransfer({ projectId: config.projectId, document: exported.document }).config, script);
    assert.equal('status' in (exported.document as object), false);
    assert.throws(() => exportAutomationDefinition({ ...definition, config: script }, 'source'), /losslessly/);
  });
  it('round trips all native template actions and rejects lossy source conversion', () => {
    for (const templateId of studioNativeTemplateIdSchema.options) {
      const needsProvider = studioNativeTemplateRequiresProvider(templateId);
      const pm = isPmAutomationTemplateId(templateId);
      const arguments_ = pm ? pmAutomationDefaultArguments(templateId) : { source_field: 'preserved', nested: { limit: 5 } };
      const native = studioConfigSchema.parse({ ...config, templateId, templateVersion: pm ? pmAutomationTemplateVersion : 'production-pinned', templateInputs: pm ? arguments_ : { source_field: 'preserved' }, action: { kind: 'template', templateId, arguments: arguments_, providerInstanceId: needsProvider ? 'configured-provider' : null, model: needsProvider ? 'configured-model' : null, options: needsProvider ? { reasoning: 'high' } : {}, repositories: pm ? [] : [{ id: 'configured-repository', ref: 'main' }], plugins: [], timeoutSeconds: 600 } });
      const exported = exportAutomationDefinition({ ...definition, config: native }, 'bundle');
      assert.deepEqual(parseAutomationTransfer({ projectId: config.projectId, document: exported.document }).config, native);
      assert.throws(() => exportAutomationDefinition({ ...definition, config: native }, 'source'), /losslessly/);
    }
  });
  it('supports source v1 prompt interchange with explicit local Provider binding', () => {
    const exported = exportAutomationDefinition(definition, 'source');
    const imported = parseAutomationTransfer({ projectId: config.projectId, document: exported.document, providerInstanceId: config.action.kind === 'prompt' ? config.action.providerInstanceId : '', model: 'configured-model' });
    assert.deepEqual(imported.config, config);
    assert.ok(imported.warnings.some(warning => warning.includes('draft')));
    assert.throws(() => parseAutomationTransfer({ projectId: config.projectId, document: exported.document }), /Select a Provider/);
    assert.throws(() => parseAutomationTransfer({ projectId: config.projectId, document: { ...(exported.document as object), unknown: true }, providerInstanceId: 'configured-provider' }), /Unrecognized/);
  });
  it('rejects unknown bundle fields, wrong scope, path traversal and opaque bundles', () => {
    assert.throws(() => parseAutomationTransfer({ projectId: 'PRJ-002', document: { version: 1, kind: 'pm-automation-bundle', spec: config } }), /projectId/);
    assert.throws(() => parseAutomationTransfer({ projectId: config.projectId, document: { version: 1, kind: 'pm-automation-bundle', spec: { ...config, secret: 'not-accepted' } } }), /Unrecognized/);
    assert.throws(() => decodeAutomationTar(tar('../outside.py', 'print(1)')), /Unsafe/);
    assert.throws(() => decodeAutomationTar(tar('link.py', '', '2')), /regular files/);
    assert.deepEqual(decodeAutomationTar(tar('main.py', 'print(1)')), [{ path: 'main.py', content: 'print(1)' }]);
  });
  it('authenticates optional encrypted remote documents and never pretends wrong-key success', () => {
    const encrypted = encryptAutomationGitDocument('real definition', 'fixture-passphrase-long-enough');
    assert.equal(decryptAutomationGitDocument(encrypted, 'fixture-passphrase-long-enough'), 'real definition');
    assert.throws(() => decryptAutomationGitDocument(encrypted, 'wrong-fixture-passphrase'), /authentication failed/);
    const modified = JSON.parse(encrypted); modified.ciphertext = Buffer.from('tampered').toString('base64');
    assert.throws(() => decryptAutomationGitDocument(JSON.stringify(modified), 'fixture-passphrase-long-enough'), /authentication failed/);
  });
  it('uses actor/project-bound private storage and requires an explicit deployment master key', () => {
    const git = createConfiguredAutomationGitPort({ PM_AUTOMATION_GIT_MASTER_KEY: Buffer.alloc(32, 7).toString('base64') });
    const sealed = git.seal('private-fixture-token', 'workspace:actor:project:token');
    assert.equal(git.open(sealed, 'workspace:actor:project:token'), 'private-fixture-token');
    assert.throws(() => git.open(sealed, 'other-actor'), /authentication failed/);
    assert.throws(() => createConfiguredAutomationGitPort({}).seal('token', 'scope'), /MASTER_KEY/);
  });
});
