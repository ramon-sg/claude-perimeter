import path from 'node:path';

/**
 * Lo que nunca debe leer un comando del agente: credenciales de clusters y de
 * nubes. El sandbox lo bloquea a nivel del sistema operativo, también para los
 * scripts y procesos hijos.
 */
export const PROTECTED_READ_PATHS = ['~/.kube', '~/.config/gcloud', '~/.aws', '~/.azure', '~/.ssh'];

/**
 * Comandos que corren fuera del sandbox porque necesitan una credencial o la
 * red de GitHub, que no funcionan adentro. Fuera del sandbox corren con tu
 * acceso completo, así que la lista es corta y por subcomando: `gh gist`,
 * `gh extension`, `gh alias` o `gh release upload` quedan dentro, sin red.
 * Lo que estos sí pueden hacer (leer un archivo con --body-file, ejecutar un
 * programa con --upload-pack) lo revisa el guardia de git.
 */
export const EXCLUDED_COMMANDS = [
  'kubectl *',
  'helm *',
  'git push *',
  'git fetch *',
  'git pull *',
  // De gh, solo lo que lee o publica sin escribir archivos locales:
  // `gh pr checkout` y `gh run download` quedan dentro del sandbox.
  ...['view', 'list', 'create', 'edit', 'ready', 'merge', 'checks', 'diff', 'status', 'comment', 'review'].map(
    (subcommand) => `gh pr ${subcommand} *`,
  ),
  'gh issue view *',
  'gh issue list *',
  ...['view', 'list', 'watch', 'rerun'].map((subcommand) => `gh run ${subcommand} *`),
  'gh api *',
  'gh repo view *',
  'gh auth status*',
];

/** De los excluidos, los que además preguntan antes de cada uso. */
export const ASK_COMMANDS = ['kubectl *', 'helm *'];

/** Dominios que los comandos del sandbox pueden usar sin preguntar. */
export const ALLOWED_DOMAINS = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
  'raw.githubusercontent.com',
];

/**
 * Socket de Docker que el sandbox deja usar.
 *
 * - macOS: solo el de Docker Desktop. Lo que un contenedor puede montar lo
 *   limita su File sharing, que el doctor revisa. `/var/run/docker.sock` no,
 *   porque puede apuntar a OrbStack, que no limita nada.
 * - Linux: ninguno. El socket con root es acceso de root a la máquina, y un
 *   Docker rootless del mismo usuario puede montar su `~/.kube`. Para Docker
 *   dentro del sandbox en Linux hace falta un usuario propio para el agente.
 *
 * @param {NodeJS.Platform} platform
 * @param {string} home
 */
export const dockerSockets = (platform, home) => (platform === 'darwin' ? [path.join(home, '.docker/run/docker.sock')] : []);

/**
 * Cachés propios del agente para npm y pnpm. Nunca los tuyos: lo que el agente
 * escribe en un caché que después usas tú fuera del sandbox (tu `pnpm install`,
 * el `npx` con que corres `claude-guard setup`) sería código suyo corriendo con
 * tu acceso. Es la única carpeta fuera del proyecto que el sandbox deja escribir.
 *
 * @param {string} home
 */
export const agentCaches = (home) => ({
  root: path.join(home, '.cache/claude-guard'),
  npm: path.join(home, '.cache/claude-guard/npm'),
  pnpmStore: path.join(home, '.cache/claude-guard/pnpm-store'),
});

/** Lo que nunca escribe un comando del sandbox, aunque una regla más amplia lo permita. */
export const PROTECTED_WRITE_PATHS = ['~/.npm/_npx', '~/.claude', '~/.config/gh'];

/**
 * Arma el archivo `managed-settings.d/50-claude-guard.json`.
 *
 * @param {{ platform: NodeJS.Platform, home: string, hooksDirectory: string }} options
 */
export const buildManagedSettings = ({ platform, home, hooksDirectory }) => ({
  $schema: 'https://json.schemastore.org/claude-code-settings.json',
  env: {
    npm_config_cache: agentCaches(home).npm,
    npm_config_store_dir: agentCaches(home).pnpmStore,
  },
  permissions: {
    // La herramienta Read no pasa por el sandbox: se bloquea aparte.
    deny: PROTECTED_READ_PATHS.flatMap((protectedPath) => [
      `Read(${protectedPath}/**)`,
      `Edit(${protectedPath}/**)`,
      `Write(${protectedPath}/**)`,
    ]),
    ask: ASK_COMMANDS.map((command) => `Bash(${command})`),
  },
  sandbox: {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    excludedCommands: EXCLUDED_COMMANDS,
    filesystem: {
      denyRead: PROTECTED_READ_PATHS,
      allowWrite: [agentCaches(home).root],
      denyWrite: PROTECTED_WRITE_PATHS,
    },
    network: {
      allowedDomains: ALLOWED_DOMAINS,
      allowUnixSockets: dockerSockets(platform, home),
      allowLocalBinding: true,
    },
  },
  hooks: {
    PreToolUse: [
      {
        matcher: 'Bash',
        hooks: [{ type: 'command', command: shellQuote(path.join(hooksDirectory, 'guard-git-fs.sh')) }],
      },
    ],
    PermissionRequest: [
      {
        matcher: '*',
        hooks: [
          { type: 'command', command: shellQuote(path.join(hooksDirectory, 'log-permission-request.sh')), timeout: 10 },
        ],
      },
    ],
  },
});

/** Comillas simples para una ruta con espacios (`Application Support`). */
export const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * Revisa que un archivo de managed settings tenga lo que protege de verdad.
 * Cada resultado dice qué falta; no compara el archivo entero, para que sumar
 * dominios o comandos a mano no lo marque como roto.
 *
 * @param {any} settings el JSON ya leído.
 * @returns {{ id: string, ok: boolean, title: string }[]}
 */
export const evaluateManagedSettings = (settings) => {
  const sandbox = settings?.sandbox ?? {};
  const deny = settings?.permissions?.deny ?? [];
  const ask = settings?.permissions?.ask ?? [];
  const denyRead = sandbox.filesystem?.denyRead ?? [];
  const hookCommands = Object.values(settings?.hooks ?? {})
    .flat()
    .flatMap((entry) => entry?.hooks ?? [])
    .map((hook) => hook?.command ?? '');
  return [
    { id: 'sandbox-enabled', ok: sandbox.enabled === true, title: 'Sandbox activo' },
    {
      id: 'sandbox-fail-if-unavailable',
      ok: sandbox.failIfUnavailable === true,
      title: 'Claude Code no arranca sin sandbox (failIfUnavailable)',
    },
    {
      id: 'sandbox-no-escape',
      ok: sandbox.allowUnsandboxedCommands === false,
      title: 'Sin reintento fuera del sandbox (allowUnsandboxedCommands: false)',
    },
    {
      id: 'sandbox-deny-kube',
      ok: denyRead.some((entry) => entry.replace(/\/$/, '') === '~/.kube'),
      title: 'El sandbox no deja leer ~/.kube',
    },
    {
      id: 'read-tool-deny-kube',
      ok: deny.includes('Read(~/.kube/**)'),
      title: 'La herramienta Read no puede abrir ~/.kube',
    },
    { id: 'kubectl-ask', ok: ask.includes('Bash(kubectl *)'), title: 'kubectl pregunta antes de correr' },
    {
      id: 'git-guard-hook',
      ok: hookCommands.some((command) => command.includes('guard-git-fs.sh')),
      title: 'Guardia de git y borrados activo',
    },
    {
      id: 'permission-log-hook',
      ok: hookCommands.some((command) => command.includes('log-permission-request.sh')),
      title: 'Registro de preguntas de permisos activo',
    },
  ];
};
