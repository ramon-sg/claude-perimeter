import { spawnSync } from 'node:child_process';

/**
 * Corre un comando sin shell y devuelve su salida. Nunca lanza: un comando que
 * no existe vuelve con `code: null` y el error en `stderr`.
 *
 * @param {string} command
 * @param {string[]} [args]
 * @param {{ input?: string, cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 * @returns {{ code: number | null, stdout: string, stderr: string }}
 */
export const run = (command, args = [], options = {}) => {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    input: options.input,
    cwd: options.cwd,
    env: options.env ?? process.env,
  });
  return {
    code: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? (result.error ? String(result.error.message) : '')).trim(),
  };
};

/**
 * Corre un comando con la terminal conectada (para `sudo`, que pide la
 * contraseña). Devuelve el código de salida.
 *
 * @param {string} command
 * @param {string[]} args
 * @returns {number | null}
 */
export const runInteractive = (command, args) => spawnSync(command, args, { stdio: 'inherit' }).status;

/**
 * @param {string} name
 * @returns {boolean} si el comando está en el PATH.
 */
export const commandExists = (name) => run('sh', ['-c', `command -v ${name}`]).code === 0;
