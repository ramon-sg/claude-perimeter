import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raíz del paquete instalado (donde están `hooks/` y `package.json`). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DROP_IN_FILE_NAME = '50-claude-perimeter.json';

/** Perfil de AppArmor que deja a bubblewrap crear su aislamiento (Ubuntu 24.04+). */
export const APPARMOR_BWRAP_FILE = '/etc/apparmor.d/bwrap';
export const APPARMOR_BWRAP_PROFILE = `abi <abi/4.0>,
include <tunables/global>

profile bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
  include if exists <local/bwrap>
}
`;

/**
 * Carpeta del registro de preguntas de permisos (la misma que usa
 * `hooks/log-permission-request.sh`).
 *
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 */
export const stateDirectory = (home, env = process.env) =>
  path.join(env.XDG_STATE_HOME || path.join(home, '.local/state'), 'claude-perimeter');

/**
 * Carpeta de sistema donde Claude Code lee los managed settings.
 * https://code.claude.com/docs/en/managed-settings
 *
 * @param {NodeJS.Platform} platform
 * @returns {string | undefined} `undefined` si la plataforma no está soportada.
 */
export const systemDirectory = (platform) => {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode';
  if (platform === 'linux') return '/etc/claude-code';
  return undefined;
};

/**
 * Rutas que instala `setup`. El archivo va en `managed-settings.d/` para no
 * tocar un `managed-settings.json` que ya exista.
 *
 * @param {NodeJS.Platform} platform
 */
export const installPaths = (platform) => {
  const base = systemDirectory(platform);
  if (base === undefined) return undefined;
  return {
    base,
    dropInDirectory: path.join(base, 'managed-settings.d'),
    dropInFile: path.join(base, 'managed-settings.d', DROP_IN_FILE_NAME),
    hooksDirectory: path.join(base, 'claude-perimeter', 'hooks'),
    // Copia de Safety Net y su carpeta de configuración, las dos de root: el
    // agente no puede cambiar la versión ni aflojar sus reglas de usuario.
    safetyNetDirectory: path.join(base, 'claude-perimeter', 'cc-safety-net'),
    nodeFile: path.join(base, 'claude-perimeter', 'node'),
    safetyNetHome: path.join(base, 'claude-perimeter', 'cc-safety-net-home'),
  };
};

/**
 * Carpeta de Safety Net que trae este paquete como dependencia (en
 * `node_modules`, junto al paquete o dentro de él).
 *
 * @returns {string}
 */
export const bundledSafetyNetDirectory = () =>
  path.dirname(createRequire(import.meta.url).resolve('cc-safety-net/package.json'));

/** @returns {string} el directorio home de la persona (no el de root). */
export const userHome = () => os.homedir();

/** Nombre legible de la plataforma, para los mensajes. */
export const platformName = (platform) =>
  ({ darwin: 'macOS', linux: 'Linux' })[platform] ?? platform;
