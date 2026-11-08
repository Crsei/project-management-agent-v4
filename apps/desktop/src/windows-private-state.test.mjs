import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
// Remove, rather than merely disable, the privilege from this disposable helper's
// primary token. Its Node/PowerShell descendants cannot re-enable it, even on an
// elevated CI runner. No account, security policy or parent token is changed.
const withoutSecurityPrivilege = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class PmAclTestToken {
  [StructLayout(LayoutKind.Sequential)] struct Luid { public uint Low; public int High; }
  [StructLayout(LayoutKind.Sequential)] struct Privilege { public uint Count; public Luid Id; public uint Attributes; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool LookupPrivilegeValue(string system, string name, out Luid id);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, ref Privilege state, uint size, IntPtr previous, IntPtr returned);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, uint size, out uint required);
  public static void RemoveSecurityPrivilege() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      Luid id;
      if (!LookupPrivilegeValue(null, "SeSecurityPrivilege", out id)) throw new Win32Exception(Marshal.GetLastWin32Error());
      var removed = new Privilege { Count = 1, Id = id, Attributes = 4 };
      if (!AdjustTokenPrivileges(token, false, ref removed, 0, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
      uint size;
      GetTokenInformation(token, 3, IntPtr.Zero, 0, out size);
      if (size == 0) throw new Win32Exception(Marshal.GetLastWin32Error());
      IntPtr data = Marshal.AllocHGlobal((int)size);
      try {
        if (!GetTokenInformation(token, 3, data, size, out size)) throw new Win32Exception(Marshal.GetLastWin32Error());
        int count = Marshal.ReadInt32(data);
        for (int index = 0; index < count; index++) {
          int offset = 4 + index * 12;
          if (unchecked((uint)Marshal.ReadInt32(data, offset)) == id.Low && Marshal.ReadInt32(data, offset + 4) == id.High)
            throw new InvalidOperationException("SeSecurityPrivilege was not removed");
        }
      } finally { Marshal.FreeHGlobal(data); }
    } finally { CloseHandle(token); }
  }
}
'@
[PmAclTestToken]::RemoveSecurityPrivilege()
Write-Output 'PM_ACL_SECURITY_PRIVILEGE_ABSENT'
$nodeArguments = @(ConvertFrom-Json -InputObject $env:PM_ACL_TEST_ARGS)
& $env:PM_ACL_TEST_NODE @nodeArguments
exit $LASTEXITCODE
`;

async function runWithoutSecurityPrivilege(args, environment = {}, timeout = 120_000) {
  const systemRoot = process.env.SystemRoot;
  assert.ok(systemRoot, "Native Windows ACL tests require SystemRoot");
  const env = { ...process.env, ...environment, PM_ACL_TEST_NODE: process.execPath, PM_ACL_TEST_ARGS: JSON.stringify(args) };
  // A nested --test invocation needs its own runner/reporting protocol.
  delete env.NODE_TEST_CONTEXT;
  const result = await execute(join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", withoutSecurityPrivilege], {
    env,
    windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024,
  });
  assert.match(result.stdout, /PM_ACL_SECURITY_PRIVILEGE_ABSENT/);
  return result;
}

// Native-only registration keeps non-Windows backend suites free of skipped cases.
if (process.platform === "win32") {
  test("Windows private directories and metadata can be secured repeatedly in fresh processes without SeSecurityPrivilege", { timeout: 300_000 }, async t => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "pm-unprivileged-acl-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { mkdirSync, writeFileSync, readFileSync, symlinkSync, existsSync } from 'node:fs';
      import { join, parse } from 'node:path';
      import { assertPrivatePath, ensurePrivateDirectory, readPrivateJson, securePrivateFile, writePrivateJson } from ${JSON.stringify(new URL("./private-state.mjs", import.meta.url).href)};
      import { assertPrivatePath as assertCorePrivate, makePrivatePath } from ${JSON.stringify(new URL("../../../packages/pm-core/private-path.ts", import.meta.url).href)};
      const root = process.env.PM_ACL_TEST_ROOT;
      const desktop = join(root, 'desktop'), core = join(root, 'core');
      const iteration = Number(process.env.PM_ACL_TEST_ITERATION);
      await ensurePrivateDirectory(desktop);
      await ensurePrivateDirectory(desktop);
      const metadata = join(desktop, 'metadata.json');
      if (iteration > 1) assert.deepEqual(await readPrivateJson(metadata), { iteration: iteration - 1 });
      await writePrivateJson(metadata, { iteration }, { exclusive: iteration === 1 });
      await securePrivateFile(metadata);
      await securePrivateFile(metadata);
      await assertPrivatePath(desktop, true);
      assert.deepEqual(await readPrivateJson(metadata), { iteration });
      mkdirSync(core, { recursive: true });
      makePrivatePath(core); makePrivatePath(core); assertCorePrivate(core);
      const state = join(core, 'state.json');
      if (iteration === 1) writeFileSync(state, 'preserved core state', { flag: 'wx' });
      makePrivatePath(state); makePrivatePath(state); assertCorePrivate(state);
      assert.equal(readFileSync(state, 'utf8'), 'preserved core state');
      await assert.rejects(ensurePrivateDirectory(parse(root).root), /filesystem root/);
      const alias = join(root, 'linked');
      if (!existsSync(alias)) symlinkSync(core, alias, 'junction');
      await assert.rejects(ensurePrivateDirectory(alias), /Unsafe/);
      assert.throws(() => makePrivatePath(alias), /Unsafe/);
      const exposed = join(desktop, 'exposed-' + iteration + '.json');
      await writePrivateJson(exposed, { mustRemain: true }, { exclusive: true });
      execFileSync(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ${JSON.stringify(String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1')
Import-Module ($PSHOME+'\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')
$acl = Get-Acl -LiteralPath $env:PM_ACL_EXPOSED_FILE
$everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Read', 'Allow'))
[IO.File]::SetAccessControl($env:PM_ACL_EXPOSED_FILE, $acl)
`)},
      ], { env: { ...process.env, PM_ACL_EXPOSED_FILE: exposed }, windowsHide: true, stdio: 'pipe', timeout: 30_000 });
      await assert.rejects(readPrivateJson(exposed), /ACL cannot be verified/);
      assert.throws(() => assertCorePrivate(exposed), /current-user-only Windows ACL/);
      await assert.rejects(readPrivateJson(exposed), /ACL cannot be verified/);
      assert.deepEqual(JSON.parse(readFileSync(exposed, 'utf8')), { mustRemain: true });
      console.log('PM_ACL_PRIVATE_STATE_PRESERVED');
    `;
    for (const iteration of [1, 2]) {
      const result = await runWithoutSecurityPrivilege(["--conditions=development", "--input-type=module", "--eval", "await import(process.env.PM_ACL_TEST_MODULE)"], {
        PM_ACL_TEST_ROOT: root, PM_ACL_TEST_ITERATION: String(iteration),
        PM_ACL_TEST_MODULE: `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`,
      });
      assert.match(result.stdout, /PM_ACL_PRIVATE_STATE_PRESERVED/);
    }
    t.diagnostic("Real Windows ACL helpers ran in two fresh process trees with SeSecurityPrivilege removed; protected state survived reconnect, while roots/junctions and nonprivate metadata remained rejected without repair.");
  });

  if (process.env.PM_DESKTOP_TEST_POSTGRES_ROOT) {
    test("Windows real managed bootstrap, durable recovery and reconnect work without SeSecurityPrivilege", { timeout: 720_000 }, async t => {
      // The existing integration suite owns its random temporary roots/ports and
      // exercises real PG16, migrations, first-account/password authorization,
      // Nova initialization, pending recovery and identity-preserving restart.
      const result = await runWithoutSecurityPrivilege(["--conditions=development", "--test", "--test-reporter=tap", fileURLToPath(new URL("./backend/bootstrap.test.ts", import.meta.url))], {}, 700_000);
      assert.match(result.stdout, /# fail 0/);
      assert.match(result.stdout, /# skipped 0/);
      t.diagnostic(result.stdout);
    });
  }
}
