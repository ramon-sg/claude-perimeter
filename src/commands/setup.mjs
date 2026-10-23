import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { HOOK_FILES } from '../checks/machine.mjs';
import { dockerProvider } from '../checks/docker.mjs';
import { commandExists, run, runInteractive } from '../exec.mjs';
import { buildManagedSettings } from '../managed-settings.mjs';
import { PACKAGE_ROOT, bundledSafetyNetDirectory, installPaths, platformName, userHome } from '../platform.mjs';
import { safetyNetVersion } from '../checks/safety-net.mjs';
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

/**
 * ¿<nodePath> arranca copiado a otra carpeta? Lo prueba en un temporal.
 *
 * @param {string} nodePath
 */
const nodeRunsWhenCopied = (nodePath) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-perimeter-node-'));
  try {
    const copy = path.join(directory, 'node');
    fs.copyFileSync(nodePath, copy);
    fs.chmodSync(copy, 0o755);
    return run(copy, ['-e', 'process.stdout.write(process.version)']).stdout === process.version;
  } catch {
    return false;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
};

/** Corre un paso con sudo y corta si falla. */
const sudo = (args) => {
  const code = runInteractive('sudo', args);
  if (code !== 0) throw new Error(`falló: sudo ${args.join(' ')}`);
};

const writeTemporary = (name, content) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-perimeter-'));
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
 * `claude-perimeter setup`: instala la configuración de máquina. Pide sudo para
 * escribir en la carpeta de sistema de Claude Code: ese es el punto, el agente
 * no puede editar lo que queda ahí.
 *
 * @param {{ dryRun?: boolean, yes?: boolean, uninstall?: boolean }} options
 */
export const setup = async (options) => {
  const platform = process.platform;
  const paths = installPaths(platform);
  if (paths === undefined) {
    process.stderr.write(`claude-perimeter: ${platformName(platform)} no está soportado (solo macOS y Linux).\n`);
    return 1;
  }

  if (options.uninstall) {
    process.stdout.write(`Voy a borrar:\n  ${paths.dropInFile}\n  ${path.dirname(paths.hooksDirectory)}\n`);
    if (options.dryRun) return 0;
    if (!(await confirm('¿Sigo?', options.yes))) return 1;
    sudo(['rm', '-f', paths.dropInFile]);
    sudo(['rm', '-rf', path.dirname(paths.hooksDirectory)]);
    runInteractive('sudo', ['-k']);
    process.stdout.write('Listo: claude-perimeter quedó desinstalado de esta máquina.\n');
    return 0;
  }

  // El hook de Safety Net corre con una copia de root del node con que corres
  // setup: si usara tu node (en ~/.asdf o Homebrew), cambiarlo desarmaría el
  // hook. Un node que depende de librerías propias no arranca copiado suelto;
  // ahí se usa el original y el doctor lo avisa.
  const nodeCopyWorks = nodeRunsWhenCopied(process.execPath);
  const settings = buildManagedSettings({
    platform,
    home: userHome(),
    hooksDirectory: paths.hooksDirectory,
    nodePath: nodeCopyWorks ? paths.nodeFile : process.execPath,
    safetyNetDirectory: paths.safetyNetDirectory,
    safetyNetHome: paths.safetyNetHome,
  });
  const settingsJson = `${JSON.stringify(settings, null, 2)}\n`;
  const group = rootGroup(platform);
  const safetyNetSource = bundledSafetyNetDirectory();
  const steps = [
    nodeCopyWorks
      ? {
          description: `Copiar node (${process.version}) a ${paths.nodeFile} (de root, lo usa Safety Net)`,
          run: () => {
            sudo(['mkdir', '-p', path.dirname(paths.nodeFile)]);
            sudo(['install', '-m', '0755', '-o', 'root', '-g', group, process.execPath, paths.nodeFile]);
          },
        }
      : {
          description: `Usar ${process.execPath} para Safety Net: copiado suelto no arranca, y no es de root (el doctor lo avisa)`,
          run: () => {},
        },
    {
      description: `Copiar Safety Net ${safetyNetVersion(safetyNetSource)} a ${paths.safetyNetDirectory} (de root)`,
      run: () => {
        sudo(['rm', '-rf', paths.safetyNetDirectory]);
        sudo(['mkdir', '-p', path.dirname(paths.safetyNetDirectory), paths.safetyNetHome]);
        sudo(['cp', '-R', safetyNetSource, paths.safetyNetDirectory]);
        sudo(['chown', '-R', `root:${group}`, paths.safetyNetDirectory, paths.safetyNetHome]);
        sudo(['chmod', '-R', 'go-w', paths.safetyNetDirectory, paths.safetyNetHome]);
      },
    },
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

  process.stdout.write(`claude-perimeter setup (${platformName(platform)})\n\nPasos:\n`);
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
    process.stderr.write(`\nclaude-perimeter setup se detuvo: ${error.message}\n`);
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
