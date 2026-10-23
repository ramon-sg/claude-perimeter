import fs from 'node:fs';
import path from 'node:path';
import { doctor } from './commands/doctor.mjs';
import { init } from './commands/init.mjs';
import { setup } from './commands/setup.mjs';
import { PACKAGE_ROOT } from './platform.mjs';

const HELP = `claude-guard: barandas para Claude Code.

Uso:
  claude-guard setup     Configura la máquina (sandbox, permisos, hooks). Pide sudo.
  claude-guard init      Configura el repo donde lo corres (.claude-guard.json).
  claude-guard doctor    Revisa la máquina y el repo, y dice qué falta.

Opciones de setup:
  --dry-run      Muestra qué haría, sin cambiar nada.
  --yes          No pregunta antes de cada paso.
  --uninstall    Borra lo que instaló setup.

Opciones de init (sin opciones y con una terminal, init pregunta):
  --merge-base <rama>       Rama a la que el agente puede mergear sin preguntar (repetible).
  --protect <rama>          Rama protegida además de main, master, staging y production (repetible).
  --yes                     No pregunta: usa la sugerencia (staging, si existe).

Opciones de doctor:
  --repo         Solo el repo.
  --machine      Solo la máquina.
  --explain      Muestra el detalle de cada aviso.
  --offline      Sin consultas a GitHub.
  --json         Salida en JSON.

Más: https://github.com/ramon-sg/claude-guard
`;

/**
 * @param {string[]} args
 * @param {string} name
 * @returns {string[]} todos los valores de `--name <valor>`.
 */
const values = (args, name) => args.flatMap((arg, index) => (arg === name && args[index + 1] ? [args[index + 1]] : []));

/**
 * @param {string[]} argv argumentos sin `node` ni el script.
 * @returns {Promise<number>} código de salida.
 */
export const main = async (argv) => {
  const [command, ...args] = argv;
  const has = (flag) => args.includes(flag);
  switch (command) {
    case 'setup':
      return setup({ dryRun: has('--dry-run'), yes: has('--yes'), uninstall: has('--uninstall') });
    case 'init':
      return init({
        mergeBases: has('--merge-base') ? values(args, '--merge-base') : undefined,
        protectedBranches: has('--protect') ? values(args, '--protect') : undefined,
        yes: has('--yes'),
      });
    case 'doctor':
      return doctor({
        repoOnly: has('--repo'),
        machineOnly: has('--machine'),
        explain: has('--explain'),
        offline: has('--offline'),
        json: has('--json'),
      });
    case '--version':
    case '-v':
      process.stdout.write(`${JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')).version}\n`);
      return 0;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(HELP);
      return 0;
    default:
      process.stderr.write(`claude-guard: no conozco el comando "${command}".\n\n${HELP}`);
      return 1;
  }
};
