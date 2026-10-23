import fs from 'node:fs';
import path from 'node:path';
import { commandExists, run } from '../exec.mjs';

/**
 * Qué Docker atiende los comandos `docker`, según el contexto activo.
 *
 * @param {string} contextName salida de `docker context show`.
 * @param {string} host endpoint del contexto (`unix:///…/docker.sock`).
 * @returns {'docker-desktop' | 'orbstack' | 'colima' | 'other'}
 */
export const dockerProvider = (contextName, host) => {
  if (contextName === 'orbstack' || host.includes('/.orbstack/')) return 'orbstack';
  if (contextName.startsWith('colima') || host.includes('/.colima/')) return 'colima';
  if (contextName === 'desktop-linux' || host.includes('/.docker/run/docker.sock')) return 'docker-desktop';
  return 'other';
};

/**
 * ¿Las carpetas compartidas de Docker Desktop dejan montar el home completo?
 * Si `/Users` (o el home, o `/`) está en la lista, un contenedor puede montar
 * `~/.kube` aunque el sandbox no deje leerlo.
 *
 * @param {string[]} directories `FilesharingDirectories` de Docker Desktop.
 * @param {string} home
 * @returns {{ ok: boolean, exposing: string[] }}
 */
export const evaluateFileSharing = (directories, home) => {
  const normalizedHome = path.resolve(home);
  const exposing = directories.filter((directory) => {
    const normalized = path.resolve(directory);
    return normalizedHome === normalized || normalizedHome.startsWith(`${normalized === '/' ? '' : normalized}/`);
  });
  return { ok: exposing.length === 0, exposing };
};

/** Lee `FilesharingDirectories` del archivo de configuración de Docker Desktop. */
const readFileSharingDirectories = (home) => {
  const container = path.join(home, 'Library/Group Containers/group.com.docker');
  for (const name of ['settings-store.json', 'settings.json']) {
    try {
      const settings = JSON.parse(fs.readFileSync(path.join(container, name), 'utf8'));
      const directories = settings.FilesharingDirectories ?? settings.filesharingDirectories;
      if (Array.isArray(directories)) return directories;
    } catch {
      // El archivo no existe o no es JSON: se prueba el siguiente.
    }
  }
  return undefined;
};

/**
 * Checks de Docker para macOS: tiene que ser Docker Desktop y sus carpetas
 * compartidas no pueden incluir el home.
 *
 * @param {string} home
 */
export const macosDockerChecks = (home) => {
  if (!commandExists('docker')) {
    return [
      {
        id: 'docker-installed',
        status: 'warn',
        title: 'Docker no está instalado',
        fix: 'Si tus proyectos usan Docker, instala Docker Desktop: brew install --cask docker',
      },
    ];
  }
  const contextName = run('docker', ['context', 'show']).stdout;
  const host = run('docker', ['context', 'inspect', contextName, '--format', '{{.Endpoints.docker.Host}}']).stdout;
  const provider = dockerProvider(contextName, host);
  if (provider !== 'docker-desktop') {
    const names = { orbstack: 'OrbStack', colima: 'Colima', other: `el contexto "${contextName}"` };
    return [
      {
        id: 'docker-provider',
        status: 'fail',
        title: `Docker: usas ${names[provider]}, falta Docker Desktop`,
        detail:
          'Solo Docker Desktop deja limitar qué carpetas de tu Mac puede montar un contenedor. Con otro, ' +
          'un `docker run -v ~/.kube:…` abre lo que el sandbox protege.',
        fix: 'Instala Docker Desktop (brew install --cask docker) y actívalo: docker context use desktop-linux',
      },
    ];
  }
  const checks = [{ id: 'docker-provider', status: 'ok', title: 'Docker: Docker Desktop' }];
  const directories = readFileSharingDirectories(home);
  if (directories === undefined) {
    checks.push({
      id: 'docker-file-sharing',
      status: 'warn',
      title: 'No pude leer las carpetas compartidas de Docker Desktop',
      fix: 'Revisa Docker Desktop → Settings → Resources → File sharing: deja solo tus carpetas de proyectos.',
    });
    return checks;
  }
  const { ok, exposing } = evaluateFileSharing(directories, home);
  checks.push(
    ok
      ? { id: 'docker-file-sharing', status: 'ok', title: 'Docker Desktop no puede montar tu home completo' }
      : {
          id: 'docker-file-sharing',
          status: 'fail',
          title: `Docker Desktop comparte ${exposing.join(', ')}: puede montar ~/.kube`,
          fix:
            'Docker Desktop → Settings → Resources → File sharing: quita esas carpetas y agrega solo ' +
            'tus proyectos (por ejemplo ~/Projects). Después, Apply & restart.',
        },
  );
  return checks;
};

/** Checks de Docker para Linux: sin root, un contenedor no puede montar archivos de otros usuarios. */
export const linuxDockerChecks = () => {
  if (!commandExists('docker')) {
    return [{ id: 'docker-installed', status: 'skip', title: 'Docker no está instalado' }];
  }
  const securityOptions = run('docker', ['info', '--format', '{{json .SecurityOptions}}']).stdout;
  if (securityOptions.includes('rootless')) {
    return [{ id: 'docker-rootless', status: 'ok', title: 'Docker corre sin root (rootless)' }];
  }
  return [
    {
      id: 'docker-rootless',
      status: 'warn',
      title: 'Docker corre con root: un contenedor puede montar cualquier carpeta',
      detail: 'Quien usa ese Docker puede leer ~/.kube montándolo en un contenedor.',
      fix:
        'Si el agente corre en esta máquina, usa Docker rootless con un usuario propio para el agente, ' +
        'o no dejes el kubeconfig de prod en esta máquina.',
    },
  ];
};
