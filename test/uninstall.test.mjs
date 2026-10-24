import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { uninstallItems } from '../src/commands/uninstall.mjs';
import { APPARMOR_BWRAP_FILE, APPARMOR_BWRAP_PROFILE, installPaths } from '../src/platform.mjs';

/**
 * Máquina falsa: `files` son las rutas que existen (con su contenido),
 * `commands` lo que está en el PATH y `casks` lo que lista Homebrew.
 */
const probe = ({ files = {}, commands = [], casks = [] }) => ({
  exists: (file) => file in files,
  readFile: (file) => files[file],
  commandExists: (name) => commands.includes(name),
  brewCasks: () => casks,
});

const items = (platform, machine, env = {}) =>
  uninstallItems({ platform, paths: installPaths(platform), home: '/home/ana', env, probe: probe(machine) }).map(
    ({ description, kind, required }) => ({ description, kind, required: required ?? false }),
  );

const darwin = installPaths('darwin');
const linux = installPaths('linux');

describe('uninstallItems', () => {
  it('sin nada instalado no ofrece nada', () => {
    assert.deepEqual(items('darwin', {}), []);
    assert.deepEqual(items('linux', { commands: ['apt-get'] }), []);
  });

  it('borra siempre la configuración y la carpeta de root, y pregunta por la caché y el registro', () => {
    const files = {
      [darwin.dropInFile]: '{}',
      '/Library/Application Support/ClaudeCode/claude-perimeter': '',
      '/home/ana/.cache/claude-perimeter': '',
      '/home/ana/.local/state/claude-perimeter': '',
    };
    assert.deepEqual(items('darwin', { files }), [
      { description: `La configuración: ${darwin.dropInFile}`, kind: 'perimeter', required: true },
      {
        description: 'Los hooks, la copia de Safety Net y la de node: /Library/Application Support/ClaudeCode/claude-perimeter',
        kind: 'perimeter',
        required: true,
      },
      { description: 'La caché de paquetes del agente: /home/ana/.cache/claude-perimeter', kind: 'perimeter', required: false },
      {
        description: 'El registro de preguntas de permisos: /home/ana/.local/state/claude-perimeter',
        kind: 'perimeter',
        required: false,
      },
    ]);
  });

  it('busca el registro en XDG_STATE_HOME si está definido', () => {
    const files = { '/xdg/claude-perimeter': '' };
    assert.deepEqual(items('linux', { files }, { XDG_STATE_HOME: '/xdg' }), [
      { description: 'El registro de preguntas de permisos: /xdg/claude-perimeter', kind: 'perimeter', required: false },
    ]);
  });

  it('en macOS ofrece Docker Desktop como programa, con cualquiera de sus dos nombres en Homebrew', () => {
    for (const cask of ['docker', 'docker-desktop']) {
      assert.deepEqual(items('darwin', { casks: ['firefox', cask] }), [
        { description: `Docker Desktop (brew uninstall --cask ${cask})`, kind: 'program', required: false },
      ]);
    }
    assert.deepEqual(items('darwin', { casks: ['firefox'] }), []);
  });

  it('en Linux ofrece los paquetes del sandbox que están y el perfil de AppArmor solo si es el de setup', () => {
    const files = { [APPARMOR_BWRAP_FILE]: APPARMOR_BWRAP_PROFILE };
    assert.deepEqual(items('linux', { files, commands: ['bwrap', 'socat', 'apt-get'] }), [
      { description: 'Los paquetes bubblewrap y socat (sudo apt-get remove)', kind: 'program', required: false },
      { description: `El perfil de AppArmor para bubblewrap: ${APPARMOR_BWRAP_FILE}`, kind: 'perimeter', required: false },
    ]);
    assert.deepEqual(items('linux', { files: { [APPARMOR_BWRAP_FILE]: 'otro perfil' }, commands: ['socat', 'dnf'] }), [
      { description: 'El paquete socat (sudo dnf remove)', kind: 'program', required: false },
    ]);
  });

  it('no ofrece Docker Desktop en Linux ni paquetes en macOS', () => {
    assert.deepEqual(items('linux', { casks: ['docker'] }), []);
    assert.deepEqual(items('darwin', { commands: ['bwrap', 'socat', 'apt-get'] }), []);
  });

  it('usa las rutas de sistema de cada plataforma', () => {
    assert.equal(items('linux', { files: { [linux.dropInFile]: '{}' } })[0].description, `La configuración: ${linux.dropInFile}`);
  });
});
