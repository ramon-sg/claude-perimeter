import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { CONFIG_FILE_NAME, DEFAULT_PROTECTED_BRANCHES, RELEASE_BRANCHES } from '../checks/repo.mjs';
import { run } from '../exec.mjs';
import { doctor } from './doctor.mjs';

/** Un nombre de rama aceptable: sin espacios, sin empezar con `-`. */
const BRANCH_NAME = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/**
 * Ramas de largo plazo que existen en origin y no son de release: candidatas a
 * mergear sin preguntar (por ejemplo `staging`).
 *
 * @param {string[]} remoteBranches
 * @returns {string[]}
 */
export const suggestedMergeBases = (remoteBranches) =>
  remoteBranches.filter((branch) => DEFAULT_PROTECTED_BRANCHES.includes(branch) && !RELEASE_BRANCHES.includes(branch));

/**
 * Lee una respuesta con ramas separadas por comas o espacios.
 *
 * @param {string} answer
 * @returns {{ branches: string[], invalid: string[] }}
 */
export const parseBranchList = (answer) => {
  const items = answer
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  return {
    branches: [...new Set(items.filter((item) => BRANCH_NAME.test(item)))],
    invalid: items.filter((item) => !BRANCH_NAME.test(item)),
  };
};

/**
 * Arma el contenido de `.claude-guard.json`. Las ramas de release nunca quedan
 * en mergeBases: el guardia las ignoraría igual.
 *
 * @param {{ protectedBranches: string[], mergeBases: string[] }} answers
 * @returns {{ config: object, ignored: string[] }}
 */
export const buildConfig = ({ protectedBranches, mergeBases }) => {
  const ignored = mergeBases.filter((branch) => RELEASE_BRANCHES.includes(branch));
  return {
    ignored,
    config: {
      $comment:
        'Configuración de claude-guard (https://github.com/ramon-sg/claude-guard). protectedBranches suma ramas a main, ' +
        'master, staging y production. mergeBases son las bases a las que el agente mergea sin preguntar (nunca main, ' +
        'master ni production) y se leen de la versión de este archivo en origin/main.',
      protectedBranches: protectedBranches.filter((branch) => !DEFAULT_PROTECTED_BRANCHES.includes(branch)),
      mergeBases: mergeBases.filter((branch) => !RELEASE_BRANCHES.includes(branch)),
    },
  };
};

/**
 * Resume en lenguaje llano lo que el archivo va a hacer.
 *
 * @param {{ protectedBranches: string[], mergeBases: string[] }} config
 * @returns {string}
 */
export const describeConfig = (config) => {
  const protectedList = [...DEFAULT_PROTECTED_BRANCHES, ...config.protectedBranches].join(', ');
  const lines = [`  • Nadie pushea directo a: ${protectedList}.`];
  lines.push(
    config.mergeBases.length > 0
      ? `  • El agente mergea sin preguntarte a: ${config.mergeBases.join(', ')}. A cualquier otra base, te pregunta.`
      : '  • El agente te pregunta antes de cada merge.',
  );
  if (config.mergeBases.length > 0) {
    lines.push('  • Lo anterior aplica recién cuando este archivo llegue a origin/main (por un PR): hasta entonces, todo merge pregunta.');
  }
  return lines.join('\n');
};

const ask = async (prompt, question) => (await prompt.question(question)).trim();

/** Pregunta las dos cosas que el archivo necesita, con la sugerencia por omisión. */
const interview = async (remoteBranches) => {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    process.stdout.write(`\nRamas protegidas siempre: ${DEFAULT_PROTECTED_BRANCHES.join(', ')}.\n`);
    let extra;
    for (;;) {
      extra = parseBranchList(await ask(prompt, '¿Alguna rama más donde nadie deba pushear directo? (separadas por coma, Enter para ninguna) '));
      if (extra.invalid.length === 0) break;
      process.stdout.write(`  No son nombres de rama válidos: ${extra.invalid.join(', ')}. Prueba de nuevo.\n`);
    }
    const suggestion = suggestedMergeBases(remoteBranches);
    const suggestionText = suggestion.length > 0 ? suggestion.join(', ') : 'ninguna';
    process.stdout.write(
      '\nEl agente puede mergear sus PRs sin preguntarte, pero solo hacia las ramas que digas aquí.\n' +
        `Nunca hacia ${RELEASE_BRANCHES.join(', ')}: esos merges siempre pasan por ti.\n`,
    );
    let merge;
    for (;;) {
      const answer = await ask(prompt, `¿Hacia qué ramas? [${suggestionText}] (Enter acepta, "-" para ninguna) `);
      merge = answer === '' ? { branches: suggestion, invalid: [] } : answer === '-' ? { branches: [], invalid: [] } : parseBranchList(answer);
      const release = merge.branches.filter((branch) => RELEASE_BRANCHES.includes(branch));
      if (merge.invalid.length === 0 && release.length === 0) break;
      process.stdout.write(
        merge.invalid.length > 0
          ? `  No son nombres de rama válidos: ${merge.invalid.join(', ')}. Prueba de nuevo.\n`
          : `  ${release.join(', ')} es una rama de release: el agente nunca mergea ahí sin preguntarte. Prueba de nuevo.\n`,
      );
    }
    return { protectedBranches: extra.branches, mergeBases: merge.branches };
  } finally {
    prompt.close();
  }
};

const confirmWrite = async () => {
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(s|si|sí|y|yes|)$/i.test(await ask(prompt, `¿Escribo ${CONFIG_FILE_NAME}? [S/n] `));
  } finally {
    prompt.close();
  }
};

/**
 * `claude-guard init`: crea el `.claude-guard.json` del repo y revisa el repo.
 * Con una terminal pregunta qué proteger y hacia dónde mergear; sin terminal
 * (CI, el propio agente) usa --protect, --merge-base o la sugerencia. No
 * sobrescribe un archivo que ya existe.
 *
 * @param {{ mergeBases?: string[], protectedBranches?: string[], yes?: boolean }} options
 */
export const init = async (options) => {
  const toplevel = run('git', ['rev-parse', '--show-toplevel']).stdout;
  if (toplevel === '') {
    process.stderr.write('claude-guard init: corre esto dentro de un repo de git.\n');
    return 1;
  }
  const file = path.join(toplevel, CONFIG_FILE_NAME);
  if (fs.existsSync(file)) {
    process.stdout.write(`${CONFIG_FILE_NAME} ya existe: no lo toco. Para cambiarlo, edítalo y súbelo por un PR.\n`);
    return doctor({ repoOnly: true });
  }
  const remoteBranches = run('git', ['-C', toplevel, 'branch', '-r', '--format=%(refname:lstrip=3)']).stdout.split('\n');
  const interactive = process.stdin.isTTY && options.mergeBases === undefined && options.protectedBranches === undefined && !options.yes;
  const answers = interactive
    ? await interview(remoteBranches)
    : {
        protectedBranches: options.protectedBranches ?? [],
        mergeBases: options.mergeBases ?? suggestedMergeBases(remoteBranches),
      };
  const { config, ignored } = buildConfig(answers);
  if (ignored.length > 0) {
    process.stdout.write(`Ignoro ${ignored.join(', ')} como base de merge: es una rama de release.\n`);
  }
  process.stdout.write(`\n${CONFIG_FILE_NAME}:\n${describeConfig(config)}\n\n`);
  if (interactive && !(await confirmWrite())) {
    process.stdout.write('No escribí nada.\n');
    return 1;
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(`Creé ${CONFIG_FILE_NAME}. Commitéalo y llévalo a main con un PR, así vale en todos los clones y worktrees.\n`);
  return doctor({ repoOnly: true });
};
