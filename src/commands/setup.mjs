import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { HOOK_FILES } from '../checks/machine.mjs';
import { dockerProvider } from '../checks/docker.mjs';
import { commandExists, run, runInteractive } from '../exec.mjs';
import { buildManagedSettings } from '../managed-settings.mjs';
import { PACKAGE_ROOT, installPaths, platformName, userHome } from '../platform.mjs';
import { doctor } from './doctor.mjs';

/** Perfil de AppArmor que deja a bubblewrap crear su aislamiento (Ubuntu 24.04+). */
const APPARMOR_BWRAP_PROFILE = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

const rootGroup = (platform) => (platform === 'darwin' ? 'wheel' : 'root');

/**
 * @param {string} question
 * @param {boolean} assumeYes
 */
const confirm = async (question, assumeYes) => {
  if (assumeYes) return true;
  if (!process.stdin.isTTY) return false;
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`${question} [s/N] `);
  prompt.close();
  return /^(s|si|sí|y|yes)$/i.test(answer.trim());
};

/** Corre un paso con sudo y corta si falla. */
const sudo = (args) => {
  const code = runInteractive('sudo', args);
  if (code !== 0) throw new Error(`falló: sudo ${args.join(' ')}`);
};

const writeTemporary = (name, content) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-guard-'));
  const file = path.join(directory, name);
  fs.writeFileSync(file, content);
  return file;
};

/** Pasos que instalan algo en Linux: paquetes del sandbox y AppArmor. */
const linuxSteps = () => {
  const steps = [];
  const missing = [
    ['bwrap', 'bubblewrap'],
    ['socat', 'socat'],
  ]
    .filter(([command]) => !commandExists(command))
    .map(([, packageName]) => packageName);
  if (missing.length > 0) {
    const manager = commandExists('apt-get') ? 'apt-get' : commandExists('dnf') ? 'dnf' : undefined;
    steps.push({
      description: `Instalar ${missing.join(' y ')} (el sandbox los necesita)`,
      run: () => {
        if (manager === undefined) throw new Error(`instala a mano: ${missing.join(' ')}`);
        sudo([manager, 'install', '-y', ...missing]);
      },
    });
  }
  let restricted = '0';
  try {
    restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
  } catch {
    // Sin la clave, AppArmor no restringe nada.
  }
  if (restricted === '1' && !fs.existsSync('/etc/apparmor.d/bwrap')) {
    steps.push({
      description: 'Agregar el perfil de AppArmor para bubblewrap (Ubuntu 24.04+)',
      run: () => {
        sudo(['install', '-m', '0644', '-o', 'root', '-g', 'root', writeTemporary('bwrap', APPARMOR_BWRAP_PROFILE), '/etc/apparmor.d/bwrap']);
        sudo(['systemctl', 'reload', 'apparmor']);
      },
    });
  }
  return steps;
};

/** Pasos de Docker en macOS: ofrece instalar Docker Desktop si falta. */
const macosSteps = () => {
  const steps = [];
  const hasDockerDesktop = fs.existsSync('/Applications/Docker.app');
  if (!hasDockerDesktop && commandExists('brew')) {
    steps.push({
      description: 'Instalar Docker Desktop con Homebrew (solo él deja limitar las carpetas que se montan)',
      optional: true,
      run: () => {
        if (runInteractive('brew', ['install', '--cask', 'docker']) !== 0) throw new Error('falló brew install --cask docker');
      },
    });
  }
  return steps;
};

/** Lo que hay que hacer a mano después (Docker Desktop no se configura por línea de comandos). */
const macosManualSteps = () => {
  const notes = [];
  if (commandExists('docker')) {
    const contextName = run('docker', ['context', 'show']).stdout;
    const host = run('docker', ['context', 'inspect', contextName, '--format', '{{.Endpoints.docker.Host}}']).stdout;
    if (dockerProvider(contextName, host) !== 'docker-desktop') {
      notes.push(`Activa Docker Desktop como Docker por omisión: docker context use desktop-linux (hoy: ${contextName}).`);
    }
  }
  notes.push(
    'En Docker Desktop → Settings → Resources → File sharing: quita /Users y agrega solo tus carpetas de proyectos. Después, Apply & restart.',
  );
  return notes;
};

/**
 * `claude-guard setup`: instala la configuración de máquina. Pide sudo para
 * escribir en la carpeta de sistema de Claude Code: ese es el punto, el agente
 * no puede editar lo que queda ahí.
 *
 * @param {{ dryRun?: boolean, yes?: boolean, uninstall?: boolean }} options
 */
export const setup = async (options) => {
  const platform = process.platform;
  const paths = installPaths(platform);
  if (paths === undefined) {
    process.stderr.write(`claude-guard: ${platformName(platform)} no está soportado (solo macOS y Linux).\n`);
    return 1;
  }

  if (options.uninstall) {
    process.stdout.write(`Voy a borrar:\n  ${paths.dropInFile}\n  ${path.dirname(paths.hooksDirectory)}\n`);
    if (options.dryRun) return 0;
    if (!(await confirm('¿Sigo?', options.yes))) return 1;
    sudo(['rm', '-f', paths.dropInFile]);
    sudo(['rm', '-rf', path.dirname(paths.hooksDirectory)]);
    runInteractive('sudo', ['-k']);
    process.stdout.write('Listo: claude-guard quedó desinstalado de esta máquina.\n');
    return 0;
  }

  const settings = buildManagedSettings({ platform, home: userHome(), hooksDirectory: paths.hooksDirectory });
  const settingsJson = `${JSON.stringify(settings, null, 2)}\n`;
  const group = rootGroup(platform);
  const steps = [
    {
      description: `Copiar los hooks a ${paths.hooksDirectory} (de root)`,
      run: () => {
        sudo(['mkdir', '-p', paths.hooksDirectory, paths.dropInDirectory]);
        for (const name of HOOK_FILES) {
          sudo(['install', '-m', '0755', '-o', 'root', '-g', group, path.join(PACKAGE_ROOT, 'hooks', name), path.join(paths.hooksDirectory, name)]);
        }
      },
    },
    {
      description: `Escribir ${paths.dropInFile} (sandbox, permisos y hooks)`,
      run: () => {
        sudo(['install', '-m', '0644', '-o', 'root', '-g', group, writeTemporary('settings.json', settingsJson), paths.dropInFile]);
      },
    },
    ...(platform === 'linux' ? linuxSteps() : macosSteps()),
  ];

  process.stdout.write(`claude-guard setup (${platformName(platform)})\n\nPasos:\n`);
  for (const step of steps) process.stdout.write(`  • ${step.description}${step.optional ? ' (opcional)' : ''}\n`);
  if (options.dryRun) {
    process.stdout.write(`\nContenido de ${paths.dropInFile}:\n${settingsJson}`);
    return 0;
  }
  process.stdout.write('\n');
  if (!(await confirm('¿Sigo? Va a pedir tu contraseña de sudo.', options.yes))) {
    process.stdout.write('No hice nada.\n');
    return 1;
  }

  try {
    for (const step of steps) {
      if (step.optional && !(await confirm(`${step.description}?`, options.yes))) continue;
      process.stdout.write(`→ ${step.description}\n`);
      step.run();
    }
  } catch (error) {
    process.stderr.write(`\nclaude-guard setup se detuvo: ${error.message}\n`);
    return 1;
  } finally {
    // Olvida la contraseña de sudo: si quedara recordada, un comando del agente
    // podría usar sudo para editar lo que se acaba de instalar.
    runInteractive('sudo', ['-k']);
  }

  if (platform === 'darwin') {
    process.stdout.write('\nFalta hacer a mano:\n');
    for (const note of macosManualSteps()) process.stdout.write(`  • ${note}\n`);
  }
  process.stdout.write('\nReinicia las sesiones de Claude Code abiertas. Así queda la máquina:\n');
  return doctor({ machineOnly: true });
};
