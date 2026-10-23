import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Raíz del paquete instalado (donde están `hooks/` y `package.json`). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DROP_IN_FILE_NAME = '50-claude-perimeter.json';

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
  };
};

/** @returns {string} el directorio home de la persona (no el de root). */
export const userHome = () => os.homedir();

/** Nombre legible de la plataforma, para los mensajes. */
export const platformName = (platform) =>
  ({ darwin: 'macOS', linux: 'Linux' })[platform] ?? platform;
