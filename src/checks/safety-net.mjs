import fs from 'node:fs';
import path from 'node:path';
import { run } from '../exec.mjs';
import { isSafetyNetCommand, shellQuote } from '../managed-settings.mjs';

const SETUP_FIX = 'Corre: npx github:ramon-sg/claude-perimeter setup';

/**
 * Versión de Safety Net en <directory>, o `undefined` si no está.
 *
 * @param {string} directory
 * @returns {string | undefined}
 */
export const safetyNetVersion = (directory) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
};

/**
 * Comando del hook de Safety Net en los managed settings, si está.
 *
 * @param {any} settings
 * @returns {string | undefined}
 */
export const safetyNetCommand = (settings) =>
  (settings?.hooks?.PreToolUse ?? [])
    .flatMap((entry) => entry?.hooks ?? [])
    .map((hook) => hook?.command ?? '')
    .find(isSafetyNetCommand);

/**
 * Lee la decisión de una salida del hook: `deny`, `ask` o `allow` (sin salida).
 *
 * @param {string} stdout
 * @returns {string}
 */
export const hookDecision = (stdout) => {
  if (stdout === '') return 'allow';
  try {
    return JSON.parse(stdout)?.hookSpecificOutput?.permissionDecision ?? 'allow';
  } catch {
    return 'invalid';
  }
};

/**
 * Corre el hook instalado con un comando que tiene que bloquear. Si el hook no
 * arranca (falta node o la copia), Claude Code lo toma como un error que no
 * bloquea y deja pasar todo: por eso se prueba de verdad, no solo que exista.
 *
 * @param {string} command el comando del hook, tal como está en los settings.
 */
const probe = (command) => {
  const input = JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'git reset --hard' },
    cwd: process.cwd(),
    session_id: 'claude-perimeter-doctor',
  });
  return hookDecision(run('sh', ['-c', command], { input }).stdout);
};

/**
 * Checks de Safety Net: la copia de root, su versión y que el hook bloquee.
 *
 * @param {{ safetyNetDirectory: string, nodeFile: string }} paths
 * @param {any} settings los managed settings ya leídos (o `undefined`).
 * @param {string} bundledVersion la versión que trae este paquete.
 */
export const safetyNetChecks = (paths, settings, bundledVersion) => {
  const installedVersion = safetyNetVersion(paths.safetyNetDirectory);
  if (installedVersion === undefined) {
    return [{ id: 'safety-net', status: 'fail', title: 'Falta Safety Net', detail: paths.safetyNetDirectory, fix: SETUP_FIX }];
  }
  const checks = [];
  const stat = fs.statSync(paths.safetyNetDirectory);
  checks.push(
    stat.uid === 0 && (stat.mode & 0o022) === 0
      ? { id: 'safety-net', status: 'ok', title: `Safety Net ${installedVersion} instalado y de root` }
      : { id: 'safety-net', status: 'fail', title: 'Safety Net no es de root: el agente podría cambiarlo', fix: SETUP_FIX },
  );
  if (installedVersion !== bundledVersion) {
    checks.push({
      id: 'safety-net-version',
      status: 'warn',
      title: `Safety Net ${installedVersion} es de otra versión de claude-perimeter (esta trae ${bundledVersion})`,
      fix: SETUP_FIX,
    });
  }
  const command = safetyNetCommand(settings);
  if (command !== undefined && !command.includes(shellQuote(paths.nodeFile))) {
    checks.push({
      id: 'safety-net-node',
      status: 'warn',
      title: 'Safety Net corre con un node que no es de root',
      detail:
        'Tu node no arrancó copiado suelto (por ejemplo, el de Homebrew depende de sus librerías), así que el hook usa el ' +
        'tuyo. El sandbox no deja al agente escribir ahí, pero cambiar esa versión de node apaga el hook.',
      fix: 'Instala un node que funcione suelto (el oficial de nodejs.org, asdf o nvm) y corre setup con él.',
    });
  }
  if (command !== undefined) {
    const decision = probe(command);
    checks.push(
      decision === 'deny'
        ? { id: 'safety-net-probe', status: 'ok', title: 'Safety Net bloquea `git reset --hard` (probado)' }
        : {
            id: 'safety-net-probe',
            status: 'fail',
            title: 'El hook de Safety Net no bloquea: Claude Code deja pasar todo',
            detail: `Respuesta: ${decision}. Lo más común es que ya no exista el node con que corriste setup.`,
            fix: SETUP_FIX,
          },
    );
  }
  return checks;
};
