# claude-perimeter

Barandas para [Claude Code](https://code.claude.com): que el agente pueda trabajar solo, commitear, pushear a su rama, correr tests y abrir PRs, sin poder romper lo que no tiene vuelta atrás, como un push a `main`, un borrado fuera del proyecto o un cambio en tu cluster de producción.

```bash
npx github:ramon-sg/claude-perimeter#v0.2.0 setup    # configura la máquina (pide sudo)
npx github:ramon-sg/claude-perimeter#v0.2.0 init     # configura el repo donde estás
npx github:ramon-sg/claude-perimeter#v0.2.0 doctor   # muestra qué falta
```

No hace falta instalarlo ni publicarlo en npm: `npx` lo baja directo desde GitHub. El `#v0.2.0` fija la versión, para que lo que se instala no cambie solo.

---

## En simple

- **El problema.** Claude Code corre como tu usuario. Todo lo que tú puedes hacer, el agente también: leer tu `~/.kube/config` y tocar producción, pushear a `main`, borrar una carpeta.
- **Por qué no basta con reglas en el `CLAUDE.md`.** Son instrucciones: el modelo puede no seguirlas.
- **Por qué no basta con un filtro de comandos.** Un filtro mira el texto. Si el agente corre `python3 -c "…kubectl delete…"` o un script, el filtro ve `python3` y lo deja pasar.
- **Lo que hace claude-perimeter.** Mueve el control a donde el agente no llega:
  - **El sistema operativo** (el sandbox de Claude Code) bloquea que cualquier comando del agente, y cualquier proceso que ese comando lance, lea tus credenciales.
  - **Los managed settings**, un archivo de sistema propiedad de root, guardan esa configuración donde el agente no puede editarla.
  - **Un guardia de git** rechaza push a ramas protegidas, push forzado y merges que no son merge commit.
- **El doctor** te dice en una pantalla qué está bien y qué falta, con el paso para arreglar cada cosa.

## Qué protege y qué no

| Riesgo | Cómo se cubre | ¿Se puede saltar? |
|---|---|---|
| Leer `~/.kube`, `~/.aws`, `~/.ssh`, `~/.config/gcloud` desde un comando, un script o Python | Sandbox del sistema operativo (`denyRead`) | No, mientras el sandbox esté activo y Docker no pueda montar esas carpetas |
| Abrir esas carpetas con la herramienta Read de Claude | Regla `deny` de permisos | No |
| Cambiar algo en Kubernetes | `kubectl` y `helm` preguntan antes de cada uso (`ask`) | No: es el único camino que tiene la credencial |
| Pushear a `main`, `master`, `staging` o `production` | Guardia de git | Es un filtro de texto: atrapa equivocaciones, no intentos deliberados. La garantía es la protección de ramas en GitHub, que el doctor revisa |
| Push forzado, merge con squash o rebase | Guardia de git | Igual que la fila anterior |
| `rm -rf` fuera del proyecto | Guardia de git y archivos, y además el sandbox (solo se escribe en el proyecto y los temporales) | El sandbox no se salta |
| Que el agente desarme todo esto | Los managed settings y los hooks son de root | Solo con `sudo`: el doctor avisa si `sudo` no pide contraseña |

**Lo que no cubre** está en [Límites conocidos](#límites-conocidos).

## Requisitos

- macOS o Linux (en Windows, dentro de WSL2).
- Node 20 o más nuevo.
- Claude Code, `git` y `jq`.
- **macOS:** Docker Desktop, si usas Docker. Con OrbStack o Colima no se puede limitar qué carpetas monta un contenedor, y el doctor lo marca como problema. Ver [Docker](#docker).
- **Linux:** `bubblewrap` y `socat` para el sandbox. `setup` los instala.

## `setup`: la máquina

```bash
npx github:ramon-sg/claude-perimeter#v0.2.0 setup --dry-run   # muestra qué haría, sin tocar nada
npx github:ramon-sg/claude-perimeter#v0.2.0 setup             # lo hace (pide tu contraseña de sudo)
```

Instala dos cosas en la carpeta de sistema de Claude Code (`/Library/Application Support/ClaudeCode/` en macOS, `/etc/claude-code/` en Linux):

1. **`managed-settings.d/50-claude-perimeter.json`**, un archivo propio. Si ya tienes un `managed-settings.json`, no lo toca: Claude Code combina los dos.
2. **`claude-perimeter/hooks/`**, con el guardia de git y el registro de preguntas, propiedad de root.

Al terminar corre `sudo -k`, para que la contraseña de sudo no quede recordada y un comando del agente no pueda usarla.

Corre `setup` tú, desde tu terminal, nunca pidiéndoselo al agente, y siempre con una versión fija (`#v0.2.0`). Es el único paso que usa sudo. Si quieres revisar exactamente qué corre, clona el repo, revisa el tag y córrelo desde ahí: `node bin/claude-perimeter.mjs setup`.

### Lo que configura, pieza por pieza

| Clave | Valor | Para qué |
|---|---|---|
| `sandbox.enabled` | `true` | Todo comando de Bash del agente corre dentro del sandbox del sistema operativo |
| `sandbox.failIfUnavailable` | `true` | Si el sandbox no puede arrancar, Claude Code no arranca. Sin esto, correría los comandos sin protección |
| `sandbox.allowUnsandboxedCommands` | `false` | Un comando que falla dentro del sandbox no se puede reintentar afuera. Además, el repo ya no puede aflojar el sandbox con su propio `.claude/settings.json` |
| `sandbox.filesystem.denyRead` | `~/.kube`, `~/.aws`, `~/.azure`, `~/.config/gcloud`, `~/.ssh` | Ningún comando del sandbox puede leer credenciales |
| `sandbox.filesystem.allowWrite` | `~/.cache/claude-perimeter` | La única carpeta fuera del proyecto donde se escribe: los cachés propios del agente para npm y pnpm |
| `env` | `npm_config_cache` y `npm_config_store_dir` apuntan a `~/.cache/claude-perimeter` | El agente usa su propio caché de paquetes, no el tuyo. Así, lo que escribe no termina corriendo cuando tú instalas algo o corres `npx` fuera del sandbox. El costo: la primera instalación del agente baja todo de nuevo |
| `sandbox.filesystem.denyWrite` | `~/.npm/_npx`, `~/.claude`, `~/.config/gh` | El caché de npx (de donde corre `setup` con sudo), tu configuración de Claude Code y la de `gh` |
| `sandbox.excludedCommands` | `kubectl`, `helm`, `git push`, `git fetch`, `git pull`, y de `gh` solo lo que lee o publica sin escribir archivos locales (`pr view`/`create`/`merge`/…, `issue view`/`list`, `run view`/`list`/`watch`/`rerun`, `api`, `repo view`, `auth status`) | Corren fuera del sandbox porque necesitan una credencial o la red de GitHub. Son pocos y por subcomando: `gh pr checkout`, `gh run download`, `gh gist`, `gh extension` o `gh release upload` quedan dentro, sin red |
| `permissions.ask` | `kubectl`, `helm` | Preguntan antes de cada uso, también en modo `bypass` |
| `permissions.deny` | `Read`, `Edit` y `Write` sobre esas mismas carpetas | La herramienta Read no pasa por el sandbox: se bloquea aparte |
| `sandbox.network.allowedDomains` | npm y GitHub | Dominios que los comandos del sandbox usan sin preguntar |
| `sandbox.network.allowUnixSockets` | macOS: el socket de Docker Desktop. Linux: ninguno | En macOS los tests con Docker corren dentro del sandbox, y lo que un contenedor puede montar lo decide Docker Desktop. En Linux, ver [Docker](#docker) |
| `sandbox.network.allowLocalBinding` | `true` | Servidores de desarrollo y tests que escuchan en un puerto local |
| `hooks` | guardia de git y registro de preguntas | Ver más abajo |

### Linux

Además, `setup` instala `bubblewrap` y `socat` con `apt-get` o `dnf`. En Ubuntu 24.04 o más nuevo agrega el perfil de AppArmor que bubblewrap necesita para crear su aislamiento.

### Desinstalar

```bash
npx github:ramon-sg/claude-perimeter#v0.2.0 setup --uninstall
```

## `init`: el repo

```bash
cd mi-repo
npx github:ramon-sg/claude-perimeter#v0.2.0 init
```

Crea `.claude-perimeter.json` en la raíz del repo, si no existe, y corre el doctor del repo. Con una terminal te hace dos preguntas:

1. **¿Alguna rama más donde nadie deba pushear directo?** Además de `main`, `master`, `staging` y `production`, que siempre lo están.
2. **¿Hacia qué ramas puede mergear el agente sin preguntarte?** Sugiere `staging` si existe. Si respondes `main`, `master` o `production`, te lo rechaza: esos merges siempre pasan por ti.

Antes de escribir el archivo, te muestra en lenguaje llano qué va a hacer y te pide confirmar. Commitéalo y llévalo a `main` con un PR, así vale en todos los clones y worktrees.

```json
{
  "protectedBranches": [],
  "mergeBases": ["staging"]
}
```

- **`protectedBranches`:** ramas a las que nadie pushea, además de `main`, `master`, `staging` y `production`, que siempre lo están.
- **`mergeBases`:** bases a las que el agente puede mergear un PR sin preguntar. `init` sugiere `staging` si existe. `main`, `master` y `production` se ignoran aunque estén en la lista: un merge a una rama de release siempre pasa por ti.

Este archivo solo puede **sumar** protecciones:

- **`protectedBranches`** se lee también de tu copia de trabajo, porque solo suma.
- **`mergeBases`** afloja una regla, así que se lee de la versión commiteada en `origin/main` (o `origin/master`), donde el agente no puede pushear. Editarlo en una rama no cambia nada hasta que llegue a `main` por un PR. El doctor avisa mientras no esté ahí.
- **Si el agente lo edita para quitar algo,** las ramas por omisión siguen protegidas y las de release siguen preguntando.
- **Un merge a otro repo** (`gh pr merge -R otra/org …`) ignora esta configuración y pregunta.

Sin terminal (en CI, o cuando lo corre el agente), no pregunta: usa `--merge-base <rama>` y `--protect <rama>`, repetibles, o la sugerencia con `--yes`.

## `doctor`: qué falta

```bash
npx github:ramon-sg/claude-perimeter#v0.2.0 doctor
```

```
claude-perimeter doctor

Máquina (macOS)
  ✓ Plataforma: macOS
  ✓ Claude Code instalado
  ✓ Managed settings instalados y de root
  ✓ Sandbox activo
  ✓ El sandbox no deja leer ~/.kube
  ✓ kubectl pregunta antes de correr
  ⚠ sudo no pide contraseña ahora
      → No uses NOPASSWD en sudoers para tu usuario, y corre `sudo -k` después de usar sudo.
  ✗ Docker: usas OrbStack, falta Docker Desktop
      Solo Docker Desktop deja limitar qué carpetas de tu Mac puede montar un contenedor. …
      → Instala Docker Desktop (brew install --cask docker) y actívalo: docker context use desktop-linux

Repo
  ✓ Repo: /Users/ana/Projects/mi-repo
  ✓ .claude-perimeter.json presente
  ✓ ramon-sg/mi-repo: solo merge commit
  ✗ staging: sin protección en GitHub
      → Settings → Rules → Rulesets: para staging, exigir PR y bloquear force push (requiere admin del repo).

2 problemas, 1 aviso. Más detalle: claude-perimeter doctor --explain
```

No cambia nada. Sale con código 1 si hay algún problema, así que sirve en CI o en un script de tests.

| Opción | Qué hace |
|---|---|
| `--repo` | Solo el repo (útil en CI) |
| `--machine` | Solo la máquina |
| `--explain` | Muestra el detalle de cada aviso |
| `--offline` | Sin consultas a GitHub |
| `--json` | Salida en JSON |

### Lo que revisa

**En la máquina:**
- Claude Code, `git` y `jq`.
- Que los managed settings existan, sean JSON válido, sean de root y tengan cada pieza de la tabla de arriba.
- Que los hooks estén instalados, sean de root y coincidan con esta versión.
- Que `sudo` pida contraseña.
- **macOS:** que el Docker activo sea Docker Desktop y que sus carpetas compartidas no incluyan tu home.
- **Linux:** `bubblewrap`, `socat`, el perfil de AppArmor si hace falta, y si Docker corre sin root.

**En el repo:**
- `.claude-perimeter.json`.
- Reglas `allow` demasiado amplias en `.claude/settings.json` y `.claude/settings.local.json`, como `Bash(python3 *)` o `Bash(docker *)`, y `disableAllHooks`.
- Si los hooks de git viven dentro del repo (por ejemplo `.husky/`). Ver [Límites conocidos](#límites-conocidos).
- En GitHub: que el repo permita solo merge commit, y que cada rama protegida tenga reglas que bloqueen el push directo y el forzado.

**Lo que no revisa:** tu kubeconfig, tus contextos de Kubernetes ni nada de tu cluster. claude-perimeter nunca los abre.

## Trabajar con Kubernetes

Claude puede hacer cosas en tu cluster, pero cada vez pasa por ti:

1. **Comando por comando (lo normal).** Cada `kubectl …` te muestra la pregunta con el comando completo. Si dices que sí, corre con tu kubeconfig. Desatendido, nadie contesta y no corre.
2. **Lecturas sin preguntar.** Agrega a tu `~/.claude/settings.json` reglas como `Bash(kubectl get *)`, `Bash(kubectl describe *)` y `Bash(kubectl logs *)`, o usa un servidor MCP de Kubernetes en modo solo lectura.
3. **Una sesión con permiso amplio, cuando tú la abres.** Para una tarea larga:
   ```bash
   claude --settings '{"permissions":{"allow":["Bash(kubectl *)"]}}'
   ```
   El permiso vive solo en esa sesión. Una sesión desatendida nunca lo tiene.

**Por qué no hay atajo por Python:** un `python3 -c "subprocess.run(['kubectl', …])"` corre dentro del sandbox, igual que el `kubectl` que lanza, y ese `kubectl` no puede leer `~/.kube`. El único `kubectl` con acceso es el que escribes literal, y ese pregunta.

## Docker

El sandbox impide que el agente lea `~/.kube`, pero Docker corre fuera del sandbox, con acceso a tus archivos. Si un contenedor puede montar tu home, `docker run -v ~/.kube:/x …` abre lo que el sandbox protege.

- **macOS con Docker Desktop:** en *Settings → Resources → File sharing* quita `/Users` y deja solo tus carpetas de proyectos (por ejemplo `~/Projects`). Docker Desktop no deja montar nada fuera de esa lista.
- **macOS con OrbStack o Colima:** no tienen esa opción, así que cualquier contenedor puede montar cualquier carpeta tuya. Por eso el doctor pide Docker Desktop.
- **Linux:** Docker con root puede montar cualquier carpeta de la máquina, y un Docker *rootless* de tu mismo usuario puede montar tu `~/.kube`. Por eso, en Linux, `setup` no deja usar Docker dentro del sandbox: los comandos de Docker del agente van a fallar ahí. Si necesitas que el agente use Docker en Linux, lo seguro es un usuario de Linux propio para el agente, con Docker rootless. Así ese Docker solo ve los archivos de ese usuario, y puedes agregar su socket a `sandbox.network.allowUnixSockets`. Si el agente corre desatendido en un servidor, lo más simple es que esa máquina no tenga el kubeconfig de producción.

## El guardia de git

Corre antes de cada comando de Bash, también en modo `--dangerously-skip-permissions`.

- **Rechaza:**
  - en `git push`, `fetch` y `pull`, que corren fuera del sandbox: `--receive-pack`, `--upload-pack`, `--exec`, `-c` y variables de entorno delante, porque harían correr un programa con tu acceso completo; un destino que no es una URL de red (un repo local corre sus propios hooks); y `--git-dir`, `--work-tree`, `--namespace` o un `-C` hacia otro repo, que cargaría los hooks y la configuración de ese repo
  - en `gh`, un `--body-file`, `-F`, `--input` o `-F campo=@archivo` que apunte fuera del proyecto y de los temporales, porque podría subir una credencial a GitHub
  - en `gh`, `kubectl` y `helm`, una variable de entorno delante (`GH_PAGER=…`, `KUBECONFIG=…`) o `env`, porque puede cambiar qué programa corren o qué credencial usan. Lo mismo, junto con `git push`/`fetch`/`pull`, si otra parte del mismo comando cambia el entorno (`export`, `declare -x`, `set -a`, `source`, `.`, `eval` o una asignación suelta)
  - en `gh api`, lo que mueve ramas, crea commits, mergea o cambia protecciones y configuración del repo (por ejemplo `-X PATCH …/git/refs/heads/main`, o las mutaciones de GraphQL `updateRef`, `createCommitOnBranch` y `mergePullRequest`), porque se salta las reglas de push y merge. Leer, comentar, hacer reviews o resolver hilos sigue pasando
  - push a una rama protegida, incluido `HEAD` estando en ella, `x:main`, `--delete main`, `--all`, `--mirror` y refspecs con comodín
  - todo push forzado (`--force`, `-f`, `--force-with-lease`, `+rama`)
  - `gh pr merge` sin `--merge`, con `--squash`, `--rebase` o `--admin`
- **Pregunta:**
  - un merge cuya base no está en `mergeBases`
  - `gh api …/merge`
  - `rm -r`/`-f` o `git clean -f` fuera del proyecto y de los temporales, sobre `.git`, sobre otro worktree o con rutas que no puede resolver. Con el sandbox activo, igual nada se puede borrar fuera del proyecto y de los temporales
  - `git clean -x`
- **Con `CLAUDE_NIGHT_SHIFT=1`,** para sesiones sin nadie al lado, toda pregunta se vuelve rechazo.

Es un filtro de texto: atrapa equivocaciones, no a alguien que lo quiere esquivar. Contra eso están el sandbox y la protección de ramas en GitHub.

## Registro de preguntas

Cada vez que Claude Code te pide permiso, el hook `log-permission-request.sh` anota una línea en `~/.local/state/claude-perimeter/permission-requests/<repo>-<hash>.jsonl`. Hay un archivo por repo, compartido por el checkout principal y sus worktrees. Para ver qué te frena más:

```bash
jq -r '.tool_name + " " + .detail' ~/.local/state/claude-perimeter/permission-requests/*.jsonl \
  | sort | uniq -c | sort -rn | head -30
```

Lo que más se repite es lo que conviene aprobar en tus reglas, o en `/auto-mode-setup` si usas el modo `auto`.

- **Por qué fuera del repo:** el hook corre fuera del sandbox. Si escribiera dentro de `.git`, el agente podría cambiar el archivo por un enlace a `~/.zshrc` y hacer que el hook escribiera ahí. La carpeta queda fuera de lo que el sandbox deja escribir, se crea con permisos `700`, y el hook nunca escribe a través de un enlace.
- **Texto plano:** guarda los comandos completos. Si alguno lleva un secreto (`PGPASSWORD=…`), queda ahí.

## Límites conocidos

- **Los comandos excluidos corren con tu acceso completo.** El guardia cierra las formas de hacerles ejecutar o leer algo propio (ver [El guardia de git](#el-guardia-de-git)), pero `git push`, `git fetch` y `git pull` igual ejecutan los hooks de git del repo. Si esos hooks viven dentro del repo (por ejemplo `.husky/pre-push`), el agente podría editarlos y ese código correría fuera del sandbox. El doctor avisa cuando un repo tiene sus hooks adentro. Trabajar con el agente en worktrees lo reduce, porque la carpeta `.git` común queda fuera de lo que el sandbox deja escribir.
- **`sudo` sin contraseña desarma todo.** Quien tiene `sudo` puede editar los managed settings. Por eso `setup` corre `sudo -k` y el doctor avisa si `sudo` no pide contraseña.
- **El modo `auto` sigue preguntando por comandos complejos.** El sandbox no cambia lo que revisa el clasificador del modo `auto`. Las preguntas por comandos largos se ajustan con `/auto-mode-setup`.
- **Un `gh` con `$(…)` corre dentro del sandbox.** Claude Code deja dentro todo comando con una sustitución, y en macOS `gh` no funciona ahí. Para el cuerpo de un PR o un comentario, escríbelo a un archivo del proyecto y pásalo con `--body-file`. El guardia rechaza `--body-file` fuera del proyecto, los enlaces y las redirecciones de entrada (`< archivo`).
- **Algunas herramientas no funcionan dentro del sandbox.** En macOS, `gh` (por TLS) y git por SSH. Por eso están excluidas. Si otro comando habitual falla, revisa el mensaje: Claude Code dice qué dominio o carpeta bloqueó.
- **Los hooks de git y la configuración se revisan, pero no se fuerzan, en GitHub.** Solo un admin del repo puede activar la protección de ramas. claude-perimeter la revisa y te dice cómo pedirla.

## Desarrollo

```bash
npm test                                   # tests de Node y de los hooks
GUARD_BASH=/bin/bash bash hooks/guard-git-fs.test.sh   # el guardia en el bash 3.2 de macOS
```

Sin dependencias: Node estándar y bash. El código y los nombres están en inglés; los mensajes, los comentarios y la documentación, en español.

## Licencia

MIT
