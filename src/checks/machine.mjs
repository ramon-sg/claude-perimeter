import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { commandExists, run } from '../exec.mjs';
import { evaluateManagedSettings } from '../managed-settings.mjs';
import { PACKAGE_ROOT, bundledSafetyNetDirectory, installPaths, platformName } from '../platform.mjs';
import { linuxDockerChecks, macosDockerChecks } from './docker.mjs';
import { safetyNetChecks, safetyNetVersion } from './safety-net.mjs';

export const HOOK_FILES = ['guard-git.sh', 'log-permission-request.sh'];

const SETUP_FIX = 'Corre: npx github:ramon-sg/claude-perimeter setup';

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** ¿El archivo es de root y nadie más puede escribirlo? */
const isRootOwned = (stat) => stat.uid === 0 && (stat.mode & 0o022) === 0;

/**
 * Rutas donde suele quedar Claude Code aunque no estén en el PATH (por
 * ejemplo en una sesión SSH no interactiva).
 */
const claudeInstallPaths = (home) => [
  path.join(home, '.local/bin/claude'),
  path.join(home, '.claude/local/claude'),
  '/usr/local/bin/claude',
  '/opt/homebrew/bin/claude',
];

const toolChecks = (home) =>
  [
    ['claude', 'Claude Code instalado', 'Instala Claude Code: https://code.claude.com', claudeInstallPaths(home)],
    ['git', 'git instalado', 'Instala git.', []],
    ['jq', 'jq instalado (lo usan los hooks)', 'Instala jq: brew install jq, o apt-get install jq.', []],
  ].map(([command, title, fix, extraPaths]) =>
    commandExists(command) || extraPaths.some((candidate) => fs.existsSync(candidate))
      ? { id: `tool-${command}`, status: 'ok', title }
      : { id: `tool-${command}`, status: 'fail', title: title.replace('instalado', 'no está instalado'), fix },
  );

const managedSettingsChecks = (paths) => {
  let stat;
  try {
    stat = fs.statSync(paths.dropInFile);
  } catch {
    return [
      {
        id: 'managed-settings',
        status: 'fail',
        title: 'Falta la configuración de claude-perimeter en los managed settings',
        detail: paths.dropInFile,
        fix: SETUP_FIX,
      },
    ];
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(paths.dropInFile, 'utf8'));
  } catch {
    return [
      {
        id: 'managed-settings',
        status: 'fail',
        title: 'La configuración de claude-perimeter no es JSON válido: Claude Code no va a arrancar',
        detail: paths.dropInFile,
        fix: SETUP_FIX,
      },
    ];
  }
  const checks = [
    isRootOwned(stat)
      ? { id: 'managed-settings', status: 'ok', title: 'Managed settings instalados y de root' }
      : {
          id: 'managed-settings',
          status: 'fail',
          title: 'Los managed settings no son de root: el agente podría editarlos',
          detail: paths.dropInFile,
          fix: SETUP_FIX,
        },
  ];
  for (const rule of evaluateManagedSettings(settings)) {
    checks.push({ id: rule.id, status: rule.ok ? 'ok' : 'fail', title: rule.title, fix: rule.ok ? undefined : SETUP_FIX });
  }
  return checks;
};

const hookFileChecks = (paths) =>
  HOOK_FILES.map((name) => {
    const installed = path.join(paths.hooksDirectory, name);
    let stat;
    try {
      stat = fs.statSync(installed);
    } catch {
      return { id: `hook-${name}`, status: 'fail', title: `Falta el hook ${name}`, fix: SETUP_FIX };
    }
    if (!isRootOwned(stat)) {
      return { id: `hook-${name}`, status: 'fail', title: `El hook ${name} no es de root: el agente podría editarlo`, fix: SETUP_FIX };
    }
    if (sha256(installed) !== sha256(path.join(PACKAGE_ROOT, 'hooks', name))) {
      return { id: `hook-${name}`, status: 'warn', title: `El hook ${name} es de otra versión de claude-perimeter`, fix: SETUP_FIX };
    }
    return { id: `hook-${name}`, status: 'ok', title: `Hook ${name} instalado y al día` };
  });

const sudoCheck = () =>
  run('sudo', ['-n', 'true']).code === 0
    ? {
        id: 'sudo-password',
        status: 'warn',
        title: 'sudo no pide contraseña ahora',
        detail:
          'Con sudo sin contraseña (o recién usado), un comando del agente podría editar los managed settings. ' +
          'Fuera del sandbox, eso es lo único que los desarma.',
        fix: 'No uses NOPASSWD en sudoers para tu usuario, y corre `sudo -k` después de usar sudo.',
      }
    : { id: 'sudo-password', status: 'ok', title: 'sudo pide contraseña' };

const linuxSandboxChecks = () => {
  const checks = [
    ['bwrap', 'bubblewrap'],
    ['socat', 'socat'],
  ].map(([command, packageName]) =>
    commandExists(command)
      ? { id: `linux-${packageName}`, status: 'ok', title: `${packageName} instalado (lo usa el sandbox)` }
      : {
          id: `linux-${packageName}`,
          status: 'fail',
          title: `Falta ${packageName}: sin él no hay sandbox`,
          fix: SETUP_FIX,
        },
  );
  let restricted = '0';
  try {
    restricted = fs.readFileSync('/proc/sys/kernel/apparmor_restrict_unprivileged_userns', 'utf8').trim();
  } catch {
    // La clave no existe: AppArmor no restringe nada.
  }
  if (restricted === '1') {
    checks.push(
      fs.existsSync('/etc/apparmor.d/bwrap')
        ? { id: 'linux-apparmor', status: 'ok', title: 'AppArmor deja a bubblewrap crear su aislamiento' }
        : {
            id: 'linux-apparmor',
            status: 'fail',
            title: 'AppArmor no deja a bubblewrap crear su aislamiento (Ubuntu 24.04+)',
            fix: SETUP_FIX,
          },
    );
  }
  return checks;
};

/**
 * Todos los checks de la máquina.
 *
 * @param {{ platform: NodeJS.Platform, home: string }} options
 */
export const machineChecks = ({ platform, home }) => {
  const paths = installPaths(platform);
  if (paths === undefined) {
    return [{ id: 'platform', status: 'fail', title: `${platformName(platform)} no está soportado: solo macOS y Linux` }];
  }
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(paths.dropInFile, 'utf8'));
  } catch {
    // managedSettingsChecks ya dice qué pasa con el archivo.
  }
  return [
    { id: 'platform', status: 'ok', title: `Plataforma: ${platformName(platform)}` },
    ...toolChecks(home),
    ...managedSettingsChecks(paths),
    ...hookFileChecks(paths),
    ...safetyNetChecks(paths, settings, safetyNetVersion(bundledSafetyNetDirectory())),
    sudoCheck(),
    ...(platform === 'linux' ? linuxSandboxChecks() : []),
    ...(platform === 'darwin' ? macosDockerChecks(home) : linuxDockerChecks()),
  ];
};
