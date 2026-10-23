import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { hookDecision } from '../src/checks/safety-net.mjs';
import { run } from '../src/exec.mjs';
import { safetyNetHookCommand } from '../src/managed-settings.mjs';
import { bundledSafetyNetDirectory } from '../src/platform.mjs';

describe('hookDecision', () => {
  it('sin salida es allow; con JSON, la decisión; si no, invalid', () => {
    assert.equal(hookDecision(''), 'allow');
    assert.equal(hookDecision('{"hookSpecificOutput":{"permissionDecision":"deny"}}'), 'deny');
    assert.equal(hookDecision('no es json'), 'invalid');
  });
});

// El comando que queda en los managed settings, corrido de verdad contra la
// copia de Safety Net que trae el paquete, con una carpeta de configuración de
// solo lectura (como la de root).
describe('hook de Safety Net', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-perimeter-safety-net-'));
  fs.chmodSync(home, 0o555);
  const command = safetyNetHookCommand({
    nodePath: process.execPath,
    safetyNetDirectory: bundledSafetyNetDirectory(),
    safetyNetHome: home,
  });
  const decide = (toolInput, toolName = 'Bash') =>
    hookDecision(
      run('sh', ['-c', command], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
          tool_input: toolInput,
          cwd: process.cwd(),
          session_id: 'test',
        }),
      }).stdout,
    );

  it('bloquea comandos destructivos, también escondidos en un intérprete', () => {
    for (const shellCommand of [
      'git reset --hard',
      'git clean -fd',
      'rm -rf ~/Projects',
      'find ~ -delete',
      'python3 -c "import os; os.system(\'rm -rf ~\')"',
      'bash <<EOF\nrm -rf ~\nEOF',
    ]) {
      assert.equal(decide({ command: shellCommand }), 'deny', shellCommand);
    }
  });

  it('deja pasar lo normal, incluido un heredoc que solo es texto', () => {
    for (const shellCommand of ['git status', 'rm -rf dist', "git commit -m \"$(cat <<'EOF'\nfix: ya no usa git reset --hard\nEOF\n)\""]) {
      assert.equal(decide({ command: shellCommand }), 'allow', shellCommand);
    }
  });

  it('bloquea leer una llave SSH con la herramienta Read', () => {
    assert.equal(decide({ file_path: path.join(os.homedir(), '.ssh/id_ed25519') }, 'Read'), 'deny');
  });
});
