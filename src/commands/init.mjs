import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE_NAME, DEFAULT_PROTECTED_BRANCHES, RELEASE_BRANCHES } from '../checks/repo.mjs';
import { run } from '../exec.mjs';
import { doctor } from './doctor.mjs';

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
 * `claude-guard init`: deja el `.claude-guard.json` del repo y revisa el repo.
 * No sobrescribe un archivo que ya existe.
 *
 * @param {{ mergeBases?: string[], protectedBranches?: string[] }} options
 */
export const init = (options) => {
  const toplevel = run('git', ['rev-parse', '--show-toplevel']).stdout;
  if (toplevel === '') {
    process.stderr.write('claude-guard init: corre esto dentro de un repo de git.\n');
    return 1;
  }
  const file = path.join(toplevel, CONFIG_FILE_NAME);
  if (fs.existsSync(file)) {
    process.stdout.write(`${CONFIG_FILE_NAME} ya existe: no lo toco.\n`);
  } else {
    const remoteBranches = run('git', ['-C', toplevel, 'branch', '-r', '--format=%(refname:lstrip=3)']).stdout.split('\n');
    const config = {
      $comment:
        'Configuración de claude-guard para este repo. protectedBranches suma ramas a main, master, staging y production. ' +
        'mergeBases son las bases a las que el agente puede mergear sin preguntar (nunca main, master ni production).',
      protectedBranches: options.protectedBranches ?? [],
      mergeBases: options.mergeBases ?? suggestedMergeBases(remoteBranches),
    };
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    process.stdout.write(`Creé ${CONFIG_FILE_NAME}. Commitéalo para que valga en todos los clones y worktrees.\n`);
  }
  return doctor({ repoOnly: true });
};
