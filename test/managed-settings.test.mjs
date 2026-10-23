import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildManagedSettings, evaluateManagedSettings, shellQuote } from '../src/managed-settings.mjs';

const build = (platform = 'darwin') =>
  buildManagedSettings({
    platform,
    home: '/Users/ana',
    hooksDirectory: '/Library/Application Support/ClaudeCode/claude-perimeter/hooks',
    nodePath: '/opt/node/bin/node',
    safetyNetDirectory: '/Library/Application Support/ClaudeCode/claude-perimeter/cc-safety-net',
    safetyNetHome: '/Library/Application Support/ClaudeCode/claude-perimeter/cc-safety-net-home',
  });

describe('buildManagedSettings', () => {
  it('cierra la salida del sandbox y no arranca sin él', () => {
    const { sandbox } = build();
    assert.equal(sandbox.enabled, true);
    assert.equal(sandbox.failIfUnavailable, true);
    assert.equal(sandbox.allowUnsandboxedCommands, false);
  });

  it('bloquea ~/.kube en el sandbox y en la herramienta Read', () => {
    const settings = build();
    assert.ok(settings.sandbox.filesystem.denyRead.includes('~/.kube'));
    assert.ok(settings.permissions.deny.includes('Read(~/.kube/**)'));
  });

  it('kubectl y helm preguntan; gh y git de red corren fuera sin preguntar', () => {
    const settings = build();
    assert.deepEqual(settings.permissions.ask, ['Bash(kubectl *)', 'Bash(helm *)']);
    for (const command of ['kubectl *', 'helm *', 'gh pr create *', 'gh pr merge *', 'gh api *', 'git push *']) {
      assert.ok(settings.sandbox.excludedCommands.includes(command), command);
    }
  });

  it('no saca del sandbox a gh entero ni a los subcomandos que suben archivos o ejecutan código', () => {
    const { excludedCommands } = build().sandbox;
    for (const command of [
      'gh *',
      'gh pr *',
      'gh run *',
      'gh pr checkout *',
      'gh run download *',
      'gh gist *',
      'gh extension *',
      'gh alias *',
      'gh release *',
    ]) {
      assert.ok(!excludedCommands.includes(command), command);
    }
  });

  it('fuera del proyecto, solo deja escribir en los cachés propios del agente', () => {
    for (const platform of ['darwin', 'linux']) {
      const settings = build(platform);
      assert.deepEqual(settings.sandbox.filesystem.allowWrite, ['/Users/ana/.cache/claude-perimeter'], platform);
      assert.equal(settings.env.npm_config_cache, '/Users/ana/.cache/claude-perimeter/npm');
      assert.equal(settings.env.npm_config_store_dir, '/Users/ana/.cache/claude-perimeter/pnpm-store');
      assert.ok(settings.sandbox.filesystem.denyWrite.includes('~/.npm/_npx'), platform);
      assert.ok(settings.sandbox.filesystem.denyWrite.includes('~/.claude'), platform);
    }
  });

  it('en macOS deja usar solo el socket de Docker Desktop', () => {
    assert.deepEqual(build('darwin').sandbox.network.allowUnixSockets, ['/Users/ana/.docker/run/docker.sock']);
  });

  it('en Linux no deja usar ningún socket de Docker (con root o rootless, monta lo que sea)', () => {
    assert.deepEqual(build('linux').sandbox.network.allowUnixSockets, []);
  });

  it('registra los hooks con la ruta entre comillas (tiene espacios)', () => {
    const guard = build().hooks.PreToolUse.find((entry) => entry.matcher === 'Bash');
    assert.equal(guard.hooks[0].command, "'/Library/Application Support/ClaudeCode/claude-perimeter/hooks/guard-git.sh'");
  });

  it('registra Safety Net sin matcher, con la copia y la configuración de root', () => {
    const [safetyNet] = build().hooks.PreToolUse;
    assert.equal(safetyNet.matcher, undefined);
    assert.equal(
      safetyNet.hooks[0].command,
      "CC_SAFETY_NET_HOME='/Library/Application Support/ClaudeCode/claude-perimeter/cc-safety-net-home' " +
        "CC_SAFETY_NET_PROJECT_TIGHTEN_ONLY=1 '/opt/node/bin/node' " +
        "'/Library/Application Support/ClaudeCode/claude-perimeter/cc-safety-net/dist/bin/cc-safety-net.js' hook --claude-code",
    );
  });

  it('lo que arma pasa su propia evaluación', () => {
    for (const platform of ['darwin', 'linux']) {
      const failing = evaluateManagedSettings(build(platform)).filter((rule) => !rule.ok);
      assert.deepEqual(failing, [], platform);
    }
  });
});

describe('evaluateManagedSettings', () => {
  it('marca cada pieza que falta', () => {
    const results = Object.fromEntries(evaluateManagedSettings({}).map((rule) => [rule.id, rule.ok]));
    assert.deepEqual(Object.values(results), Object.values(results).map(() => false));
    assert.ok('sandbox-no-escape' in results);
  });

  it('allowUnsandboxedCommands ausente cuenta como abierto (su default es true)', () => {
    const settings = build();
    delete settings.sandbox.allowUnsandboxedCommands;
    const rule = evaluateManagedSettings(settings).find((entry) => entry.id === 'sandbox-no-escape');
    assert.equal(rule.ok, false);
  });

  it('Safety Net con un matcher no cuenta: dejaría fuera Read, Edit y el resto', () => {
    const settings = build();
    settings.hooks.PreToolUse[0].matcher = 'Bash';
    assert.equal(evaluateManagedSettings(settings).find((rule) => rule.id === 'safety-net-hook').ok, false);
  });

  it('acepta ~/.kube/ con barra final', () => {
    const settings = build();
    settings.sandbox.filesystem.denyRead = ['~/.kube/'];
    assert.equal(evaluateManagedSettings(settings).find((rule) => rule.id === 'sandbox-deny-kube').ok, true);
  });
});

describe('shellQuote', () => {
  it('escapa comillas simples', () => {
    assert.equal(shellQuote("a'b"), "'a'\\''b'");
  });
});
