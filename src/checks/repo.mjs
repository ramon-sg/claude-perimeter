import fs from 'node:fs';
import path from 'node:path';
import { commandExists, run } from '../exec.mjs';

export const CONFIG_FILE_NAME = '.claude-guard.json';
export const DEFAULT_PROTECTED_BRANCHES = ['main', 'master', 'staging', 'production'];
/** Ramas que nunca se mergean sin preguntar, diga lo que diga el repo. */
export const RELEASE_BRANCHES = ['main', 'master', 'production'];

/**
 * Reglas `allow` que equivalen a dejar pasar casi cualquier cosa: un intérprete,
 * un shell, Docker o un cliente de red con cualquier argumento.
 */
const BROAD_RULE =
  /^Bash\((\*|(bash|sh|zsh|python3?|node|ruby|perl|eval|exec|docker|kubectl|helm|curl|wget|ssh)( -[ce])?(:\*| \*))\)$/;

/**
 * @param {string[]} rules reglas `permissions.allow`.
 * @returns {string[]} las que son demasiado amplias.
 */
export const broadAllowRules = (rules) => rules.filter((rule) => BROAD_RULE.test(rule));

/**
 * `owner/repo` de una URL de GitHub (https o ssh).
 *
 * @param {string} url
 * @returns {{ owner: string, name: string } | undefined}
 */
export const parseGithubRemote = (url) => {
  const match = /github\.com[:/]([^/]+)\/([^/]+?)(\.git)?$/.exec(url.trim());
  return match ? { owner: match[1], name: match[2] } : undefined;
};

/**
 * ¿Las reglas de GitHub de una rama impiden el push directo y el push forzado?
 *
 * @param {{ type: string }[]} rules respuesta de `GET /repos/{o}/{r}/rules/branches/{b}`.
 * @param {boolean} classicProtected campo `protected` de `GET /repos/{o}/{r}/branches/{b}`.
 */
export const evaluateBranchRules = (rules, classicProtected) => {
  const types = new Set(rules.map((rule) => rule.type));
  const noDirectPush = types.has('pull_request') || types.has('update');
  const noForcePush = types.has('non_fast_forward');
  return { noDirectPush, noForcePush, protectedSomehow: classicProtected || noDirectPush || noForcePush };
};

/**
 * Llama a la API de GitHub con `gh` y devuelve el JSON, o `fallback` si la
 * llamada falla (404, sin permisos, sin red) o la respuesta no es JSON.
 */
const githubApi = (endpoint, fallback) => {
  const result = run('gh', ['api', endpoint]);
  if (result.code !== 0) return fallback;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return fallback;
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
};

const configChecks = (toplevel) => {
  const file = path.join(toplevel, CONFIG_FILE_NAME);
  if (!fs.existsSync(file)) {
    return [
      {
        id: 'repo-config',
        status: 'warn',
        title: `Sin ${CONFIG_FILE_NAME}: rigen las ramas protegidas por omisión`,
        detail: DEFAULT_PROTECTED_BRANCHES.join(', '),
        fix: 'Corre: npx github:ramon-sg/claude-guard init',
      },
    ];
  }
  const config = readJson(file);
  if (config === undefined) {
    return [{ id: 'repo-config', status: 'fail', title: `${CONFIG_FILE_NAME} no es JSON válido`, fix: 'Corrígelo o bórralo y corre init.' }];
  }
  const checks = [{ id: 'repo-config', status: 'ok', title: `${CONFIG_FILE_NAME} presente` }];
  const committedOnRelease = ['origin/main', 'origin/master'].some(
    (reference) => run('git', ['-C', toplevel, 'cat-file', '-e', `${reference}:${CONFIG_FILE_NAME}`]).code === 0,
  );
  if ((config.mergeBases ?? []).length > 0 && !committedOnRelease) {
    checks.push({
      id: 'repo-config-committed',
      status: 'warn',
      title: `${CONFIG_FILE_NAME} no está en origin/main: sus mergeBases todavía no aplican`,
      detail: 'mergeBases se lee de la versión commiteada en la rama de release, donde el agente no puede pushear.',
      fix: 'Mergea el archivo a main con un PR; mientras tanto, todo merge pregunta.',
    });
  }
  const ignored = (config.mergeBases ?? []).filter((branch) => RELEASE_BRANCHES.includes(branch));
  if (ignored.length > 0) {
    checks.push({
      id: 'repo-merge-bases',
      status: 'warn',
      title: `mergeBases incluye ${ignored.join(', ')}: el guardia lo ignora y pregunta igual`,
      fix: `Quítalo de ${CONFIG_FILE_NAME}: un merge a una rama de release siempre pasa por ti.`,
    });
  }
  return checks;
};

/**
 * Raíz del checkout principal. En un worktree, Claude Code lee el
 * `.claude/settings.local.json` de ahí, no el del worktree.
 */
const mainCheckoutRoot = (toplevel) => {
  const commonDirectory = run('git', ['-C', toplevel, 'rev-parse', '--path-format=absolute', '--git-common-dir']).stdout;
  return commonDirectory === '' ? toplevel : path.dirname(commonDirectory);
};

const claudeSettingsChecks = (toplevel) => {
  const checks = [];
  const roots = { 'settings.json': toplevel, 'settings.local.json': mainCheckoutRoot(toplevel) };
  for (const [name, root] of Object.entries(roots)) {
    const settings = readJson(path.join(root, '.claude', name));
    if (settings === undefined) continue;
    if (settings.disableAllHooks === true) {
      checks.push({
        id: `claude-${name}-hooks`,
        status: 'fail',
        title: `.claude/${name} apaga todos los hooks (disableAllHooks)`,
        fix: 'Quita disableAllHooks: apaga el guardia de git.',
      });
    }
    const broad = broadAllowRules(settings.permissions?.allow ?? []);
    if (broad.length > 0) {
      checks.push({
        id: `claude-${name}-broad`,
        status: 'warn',
        title: `.claude/${name} aprueba sin preguntar: ${broad.join(', ')}`,
        detail: 'Con el sandbox activo corren adentro, pero si quedan excluidos o el sandbox falla, pasan sin control.',
        fix: 'Acótalas a los subcomandos que de verdad usas.',
      });
    }
  }
  if (checks.length === 0) {
    checks.push({ id: 'claude-settings', status: 'ok', title: 'Configuración de Claude del repo sin reglas peligrosas' });
  }
  return checks;
};

const gitHooksCheck = (toplevel) => {
  const hooksPath = run('git', ['-C', toplevel, 'config', '--get', 'core.hooksPath']).stdout;
  if (hooksPath === '' || path.isAbsolute(hooksPath)) return [];
  return [
    {
      id: 'git-hooks-in-repo',
      status: 'warn',
      title: `Los hooks de git viven en el repo (${hooksPath})`,
      detail:
        'git push, git fetch y git pull corren fuera del sandbox. Si el agente edita un hook de push en esa carpeta, ' +
        'ese hook corre con tu acceso completo.',
      fix: 'Revisa en cada PR los cambios en esa carpeta, o trabaja con el agente en worktrees.',
    },
  ];
};

const githubChecks = (toplevel, protectedBranches) => {
  const remote = parseGithubRemote(run('git', ['-C', toplevel, 'remote', 'get-url', 'origin']).stdout);
  if (remote === undefined) return [{ id: 'github', status: 'skip', title: 'origin no es GitHub: sin checks de GitHub' }];
  if (!commandExists('gh') || run('gh', ['auth', 'status']).code !== 0) {
    return [{ id: 'github', status: 'warn', title: 'gh no está instalado o sin sesión: no pude revisar GitHub', fix: 'gh auth login' }];
  }
  const slug = `${remote.owner}/${remote.name}`;
  const repository = githubApi(`repos/${slug}`, undefined);
  if (repository === undefined) {
    return [{ id: 'github', status: 'warn', title: `No pude leer ${slug} en GitHub`, fix: 'Revisa tu sesión de gh y que tengas acceso al repo.' }];
  }
  const checks = [];
  const extraMethods = [
    repository.allow_squash_merge ? 'squash' : undefined,
    repository.allow_rebase_merge ? 'rebase' : undefined,
  ].filter(Boolean);
  checks.push(
    extraMethods.length === 0 && repository.allow_merge_commit !== false
      ? { id: 'github-merge-method', status: 'ok', title: `${slug}: solo merge commit` }
      : {
          id: 'github-merge-method',
          status: 'warn',
          title: `${slug}: GitHub también permite ${extraMethods.join(' y ') || 'otro método'}`,
          detail: 'El guardia ya rechaza squash y rebase desde el agente; en GitHub sigue disponible para personas.',
          fix: 'Settings → General → Pull Requests: deja solo "Allow merge commits" (requiere admin del repo).',
        },
  );
  for (const branch of protectedBranches) {
    const branchInfo = githubApi(`repos/${slug}/branches/${branch}`, undefined);
    if (branchInfo === undefined) continue;
    const classicProtected = branchInfo.protected === true;
    const rulesResponse = githubApi(`repos/${slug}/rules/branches/${branch}`, []);
    const rules = Array.isArray(rulesResponse) ? rulesResponse : [];
    const { noDirectPush, noForcePush, protectedSomehow } = evaluateBranchRules(rules, classicProtected);
    if (noDirectPush && noForcePush) {
      checks.push({ id: `github-branch-${branch}`, status: 'ok', title: `${branch}: sin push directo ni forzado en GitHub` });
    } else {
      checks.push({
        id: `github-branch-${branch}`,
        status: protectedSomehow ? 'warn' : 'fail',
        title: protectedSomehow
          ? `${branch}: protegida en GitHub, pero no pude confirmar que bloquee push directo y forzado`
          : `${branch}: sin protección en GitHub`,
        detail: 'El guardia lo bloquea desde el agente, pero solo GitHub lo garantiza para todos.',
        fix: `Settings → Rules → Rulesets: para ${branch}, exigir PR y bloquear force push (requiere admin del repo).`,
      });
    }
  }
  return checks;
};

/**
 * Todos los checks del repo donde se corre.
 *
 * @param {{ cwd: string, offline?: boolean }} options
 */
export const repoChecks = ({ cwd, offline = false }) => {
  const toplevel = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']).stdout;
  if (toplevel === '') return [{ id: 'repo', status: 'skip', title: 'No estás dentro de un repo de git' }];
  const config = readJson(path.join(toplevel, CONFIG_FILE_NAME)) ?? {};
  const protectedBranches = [...new Set([...DEFAULT_PROTECTED_BRANCHES, ...(config.protectedBranches ?? [])])];
  return [
    { id: 'repo', status: 'ok', title: `Repo: ${toplevel}` },
    ...configChecks(toplevel),
    ...claudeSettingsChecks(toplevel),
    ...gitHooksCheck(toplevel),
    ...(offline ? [] : githubChecks(toplevel, protectedBranches)),
  ];
};
