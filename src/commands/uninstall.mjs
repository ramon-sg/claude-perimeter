import fs from 'node:fs';
import path from 'node:path';
import { commandExists, confirm, run, runInteractive, sudo } from '../exec.mjs';
import { agentCaches } from '../managed-settings.mjs';
import { APPARMOR_BWRAP_FILE, APPARMOR_BWRAP_PROFILE, stateDirectory, userHome } from '../platform.mjs';

/**
 * Lo que hace falta mirar en la máquina para armar la lista. Se pasa como
 * parámetro para probar `uninstallItems` sin tocar el disco.
 *
 * @typedef {{
 *   exists: (file: string) => boolean,
 *   readFile: (file: string) => string | undefined,
 *   commandExists: (name: string) => boolean,
 *   brewCasks: () => string[],
 * }} Probe
 */

/**
 * Algo que `setup` pudo dejar en la máquina.
 *
 * - `perimeter`: lo crea claude-perimeter y nadie más lo usa. Se borra con la
 *   configuración (`required`) o con una pregunta que `--yes` contesta.
 * - `program`: un programa que `setup` pudo instalar, o que ya tenías. Siempre
 *   pregunta, también con `--yes`: puede que lo uses para otra cosa.
 *
 * @typedef {{
 *   description: string,
 *   kind: 'perimeter' | 'program',
 *   required?: boolean,
 *   warning?: string,
 *   run: () => void,
 * }} UninstallItem
 */

/** @type {Probe} */
const machineProbe = {
  exists: (file) => fs.existsSync(file),
  readFile: (file) => {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  commandExists,
  brewCasks: () => (commandExists('brew') ? run('brew', ['list', '--cask', '-1']).stdout.split('\n') : []),
};

/** Borra una carpeta de root solo si quedó vacía (la pudo crear otro programa). */
const removeIfEmpty = (directory) => {
  if (fs.existsSync(directory) && fs.readdirSync(directory).length === 0) sudo(['rmdir', directory]);
};

/**
 * Arma la lista de lo que hay para borrar, en el orden en que se ofrece. Solo
 * incluye lo que existe.
 *
 * @param {{
 *   platform: NodeJS.Platform,
 *   paths: NonNullable<ReturnType<typeof import('../platform.mjs').installPaths>>,
 *   home: string,
 *   env?: NodeJS.ProcessEnv,
 *   probe?: Probe,
 * }} options
 * @returns {UninstallItem[]}
 */
export const uninstallItems = ({ platform, paths, home, env = process.env, probe = machineProbe }) => {
  /** @type {UninstallItem[]} */
  const items = [];
  const perimeterDirectory = path.dirname(paths.hooksDirectory);

  if (probe.exists(paths.dropInFile)) {
    items.push({
      description: `La configuración: ${paths.dropInFile}`,
      kind: 'perimeter',
      required: true,
      run: () => {
        sudo(['rm', '-f', paths.dropInFile]);
        removeIfEmpty(paths.dropInDirectory);
      },
    });
  }
  if (probe.exists(perimeterDirectory)) {
    items.push({
      description: `Los hooks, la copia de Safety Net y la de node: ${perimeterDirectory}`,
      kind: 'perimeter',
      required: true,
      run: () => sudo(['rm', '-rf', perimeterDirectory]),
    });
  }

  const cache = agentCaches(home).root;
  if (probe.exists(cache)) {
    items.push({
      description: `La caché de paquetes del agente: ${cache}`,
      kind: 'perimeter',
      run: () => fs.rmSync(cache, { recursive: true, force: true }),
    });
  }
  const state = stateDirectory(home, env);
  if (probe.exists(state)) {
    items.push({
      description: `El registro de preguntas de permisos: ${state}`,
      kind: 'perimeter',
      run: () => fs.rmSync(state, { recursive: true, force: true }),
    });
  }

  if (platform === 'darwin') {
    // `setup` lo instala con `brew install --cask docker`; Homebrew lo lista
    // como `docker` o, desde que renombró el cask, `docker-desktop`.
    const cask = probe.brewCasks().find((name) => name === 'docker' || name === 'docker-desktop');
    if (cask !== undefined) {
      items.push({
        description: `Docker Desktop (brew uninstall --cask ${cask})`,
        kind: 'program',
        warning:
          'setup lo instala solo si no lo tenías, y no hay forma de saber si fue él. Si lo usas para otra cosa, contesta que no. Tus imágenes y contenedores quedan en ~/Library/Containers/com.docker.docker.',
        run: () => {
          if (runInteractive('brew', ['uninstall', '--cask', cask]) !== 0) throw new Error(`falló brew uninstall --cask ${cask}`);
        },
      });
    }
  }

  if (platform === 'linux') {
    const installed = [
      ['bwrap', 'bubblewrap'],
      ['socat', 'socat'],
    ]
      .filter(([command]) => probe.commandExists(command))
      .map(([, packageName]) => packageName);
    const manager = probe.commandExists('apt-get') ? 'apt-get' : probe.commandExists('dnf') ? 'dnf' : undefined;
    if (installed.length > 0 && manager !== undefined) {
      items.push({
        description: `${installed.length === 1 ? 'El paquete' : 'Los paquetes'} ${installed.join(' y ')} (sudo ${manager} remove)`,
        kind: 'program',
        warning:
          'setup los instala solo si faltaban, y no hay forma de saber si fue él. Otros programas pueden usarlos (Flatpak usa bubblewrap).',
        run: () => sudo([manager, 'remove', '-y', ...installed]),
      });
    }
    // Solo si el perfil es exactamente el que escribe setup: uno editado o de
    // otro origen no se toca.
    if (probe.readFile(APPARMOR_BWRAP_FILE) === APPARMOR_BWRAP_PROFILE) {
      items.push({
        description: `El perfil de AppArmor para bubblewrap: ${APPARMOR_BWRAP_FILE}`,
        kind: 'perimeter',
        run: () => {
          sudo(['rm', '-f', APPARMOR_BWRAP_FILE]);
          sudo(['systemctl', 'reload', 'apparmor']);
        },
      });
    }
  }

  return items;
};

/**
 * `claude-perimeter setup --uninstall`: borra la configuración y los archivos de
 * root sin preguntar más que una vez, y pregunta por separado por lo demás que
 * `setup` pudo dejar. Lo que no es suyo (un programa) nunca se borra con `--yes`.
 *
 * @param {{
 *   platform: NodeJS.Platform,
 *   paths: NonNullable<ReturnType<typeof import('../platform.mjs').installPaths>>,
 *   dryRun?: boolean,
 *   yes?: boolean,
 * }} options
 */
export const uninstall = async ({ platform, paths, dryRun = false, yes = false }) => {
  const items = uninstallItems({ platform, paths, home: userHome() });
  const required = items.filter((item) => item.required);
  const optional = items.filter((item) => !item.required);

  if (items.length === 0) {
    process.stdout.write('claude-perimeter no está instalado en esta máquina: no hay nada que borrar.\n');
    return 0;
  }

  process.stdout.write('claude-perimeter setup --uninstall\n');
  if (required.length > 0) {
    process.stdout.write('\nSe borra:\n');
    for (const item of required) process.stdout.write(`  • ${item.description}\n`);
  }
  if (optional.length > 0) {
    process.stdout.write('\nTe pregunto por cada uno:\n');
    for (const item of optional) process.stdout.write(`  • ${item.description}\n`);
  }
  if (dryRun) return 0;

  process.stdout.write('\n');
  if (!(await confirm('¿Sigo? Puede pedir tu contraseña de sudo.', yes))) {
    process.stdout.write('No hice nada.\n');
    return 1;
  }

  /** @type {UninstallItem[]} */
  const chosen = [...required];
  const skippedPrograms = [];
  for (const item of optional) {
    if (item.kind === 'program' && yes) {
      skippedPrograms.push(item);
      continue;
    }
    if (item.warning) process.stdout.write(`\n${item.warning}\n`);
    if (await confirm(`¿Borro ${item.description}?`, item.kind === 'perimeter' && yes)) chosen.push(item);
  }

  try {
    for (const item of chosen) {
      process.stdout.write(`→ ${item.description}\n`);
      item.run();
    }
  } catch (error) {
    process.stderr.write(`\nclaude-perimeter setup --uninstall se detuvo: ${error.message}\n`);
    return 1;
  } finally {
    runInteractive('sudo', ['-k']);
  }

  for (const item of skippedPrograms) {
    process.stdout.write(`\nNo borré ${item.description}: con --yes nunca se borra un programa. Corre el comando sin --yes si quieres quitarlo.\n`);
  }
  if (platform === 'darwin') {
    process.stdout.write(
      '\nSi en Docker Desktop limitaste las carpetas compartidas (Settings → Resources → File sharing), ese ajuste queda como está: cámbialo a mano si lo necesitas.\n',
    );
  }
  process.stdout.write('\nListo. Reinicia las sesiones de Claude Code abiertas: la configuración que ya cargaron sigue activa hasta entonces.\n');
  return 0;
};
