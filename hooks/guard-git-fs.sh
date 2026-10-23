#!/usr/bin/env bash
# Hook PreToolUse de Claude Code (matcher: Bash) que protege las ramas git
# compartidas y el sistema de archivos fuera del worktree actual.
#
# Decisiones:
#   deny  - push a una rama protegida, todo push forzado y todo `gh pr merge`
#           que no sea merge commit (o que use --admin).
#   ask   - `gh pr merge --merge` cuya base no es una base de merge permitida
#           (o no se puede resolver), `gh api .../merge`, y `rm -r/-f` o
#           `git clean -f` con una ruta fuera del worktree y de los
#           directorios temporales, o con una ruta que no se puede resolver.
#   none  - todo lo demás: decide el flujo normal de permisos.
# Si varios segmentos de un mismo comando deciden, deny gana sobre ask.
# Con CLAUDE_NIGHT_SHIFT=1 todo ask pasa a deny: nadie puede responderlo.
#
# Configuración (entorno):
#   GUARD_PROTECTED_BRANCHES  ramas a las que nadie hace push (default "staging main")
#   GUARD_MERGE_BASES         bases de PR que se mergean sin preguntar (default "staging")
#   GUARD_TEMP_ROOTS          raíces temporales separadas por ":" (default
#                             "$TMPDIR:/tmp:/private/tmp:/private/var/folders")
#   GUARD_EXTRA_SAFE_ROOTS    raíces extra separadas por ":" donde rm/clean está bien
#
# Raíces seguras para rm/clean: estrictamente dentro de la raíz del worktree
# (no la raíz misma, no dentro del git dir, no dentro de otro worktree anidado
# en ella) o estrictamente dentro de una de las raíces temporales.
#
# Es una heurística sobre el texto, no un parser de shell. Lo que no puede leer
# con confianza (variables, sustitución de comandos, un `cd` antes en el
# comando, xargs) pregunta en vez de dejarlo pasar.
#
# Uso: regístralo como hook PreToolUse de Bash, o cárgalo con `source` para
# reusar guard_segments, guard_decide y guard_emit desde otro hook.

GUARD_TAB="$(printf '\t')"

GUARD_DEFAULT_PROTECTED_BRANCHES="main master staging production"
# Ramas de release: nunca se mergean sin preguntar, diga lo que diga la config del repo.
GUARD_RELEASE_BRANCHES="main master production"

# Imprime la lista <key> (protectedBranches o mergeBases), separada por
# espacios, del .claude-perimeter.json en la raíz del repo que contiene <directory>.
guard_repo_list() {
  local toplevel file
  toplevel="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 0
  file="$toplevel/.claude-perimeter.json"
  [ -f "$file" ] || return 0
  jq -r --arg key "$2" '.[$key] // [] | .[] | strings' "$file" 2>/dev/null | tr '\n' ' '
}

# Igual que guard_repo_list, pero leyendo el .claude-perimeter.json commiteado en
# la primera rama de release que exista en origin (main o master), donde el
# agente no puede pushear. Para lo que afloja reglas, como mergeBases.
guard_committed_repo_list() {
  local reference
  for reference in origin/main origin/master; do
    if git -C "$1" cat-file -e "$reference:.claude-perimeter.json" 2>/dev/null; then
      git -C "$1" show "$reference:.claude-perimeter.json" 2>/dev/null \
        | jq -r --arg key "$2" '.[$key] // [] | .[] | strings' 2>/dev/null | tr '\n' ' '
      return 0
    fi
  done
}

# Rutas cuya única variable es una que el guard puede expandir por su cuenta.
GUARD_KNOWN_VARIABLE_PATH='^\$\{?(TMPDIR|PWD)\}?(/|$)'

# Los cuerpos de heredoc que reciben estos comandos son texto opaco (un mensaje
# de commit, un archivo que se imprime) y se descartan antes del análisis. Los
# que recibe cualquier otro comando se quedan, así las reglas de abajo los ven.
GUARD_SAFE_HEREDOC_SINKS=" cat tee printf echo "

# Comandos que toman un heredoc impreso dentro de $( … ) como texto, nunca como código.
GUARD_TEXT_CONSUMERS="git gh"
# Lo que debe ir justo antes de ese `$(`: una opción de mensaje y una comilla de apertura.
GUARD_MESSAGE_OPTION='(^|[[:space:]])(-m|--message|-b|--body|-t|--title)(=|[[:space:]]+)"$'

# Prefijos envoltorio que no cambian lo que corre (`sudo rm`, `env A=1 git push`).
GUARD_WRAP='(sudo|command|nohup)[[:space:]]+|env([[:space:]]+[A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*)*[[:space:]]+|xargs([[:space:]]+-[A-Za-z0-9{}]+)*[[:space:]]+'

guard_filter_heredocs() {
  local text="$1" mode="${2:-}" in_heredoc=0 delimiter="" skip=0 line trimmed before feeder outer out=""
  local heredoc_regex="<<-?[[:space:]]*[\"']?([A-Za-z_][A-Za-z0-9_]*)"
  while IFS= read -r line; do
    if [ "$in_heredoc" = "1" ]; then
      trimmed="$(printf '%s' "$line" | sed -E 's/^[[:space:]]+//')"
      if [ "$trimmed" = "$delimiter" ]; then
        in_heredoc=0
        [ "$skip" = "1" ] && continue
      elif [ "$skip" = "1" ]; then
        continue
      fi
      out+="$line"$'\n'
      continue
    fi
    if [[ "$line" =~ $heredoc_regex ]]; then
      delimiter="${BASH_REMATCH[1]}"
      in_heredoc=1
      before="${line%%<<*}"
      before="$(printf '%s' "$before" | sed -E 's/[[:space:]]+$//')"
      feeder="${before##* }"
      feeder="$(printf '%s' "$feeder" | sed -E 's/^[^A-Za-z_]+//')"
      # La línea que abre el heredoc también es un comando: siempre se queda.
      out+="$line"$'\n'
      # El modo "executed" descarta un cuerpo solo si lo recibe un sink seguro
      # (cat, tee, printf, echo) y nada en la línea lo pasa por un pipe: ahí es
      # texto que se imprime o se escribe a un archivo. Con cualquier otro
      # receptor el cuerpo se queda (fail closed). Un archivo escrito aquí y
      # ejecutado después queda fuera de alcance igual, como uno escrito con una
      # herramienta de edición. El receptor es la primera palabra de comando
      # del segmento que tiene el `<<`, sin ruta.
      if [ "$mode" = "executed" ]; then
        guard_tokenize "$(printf '%s' "$before" | sed -E 's/.*(&&|\|\||[;|`]|\$\()//')"
        feeder="${GUARD_TOKENS[$(guard_command_start)]:-}"
        feeder="${feeder##*/}"
        case "$GUARD_SAFE_HEREDOC_SINKS" in *" $feeder "*) skip=1 ;; *) skip=0 ;; esac
        # Un pipe, un backtick o una sustitución de proceso en la línea pueden ejecutarlo.
        case "$line" in *'|'* | *'`'* | *'<('* | *'>('*) skip=0 ;; esac
        # Dentro de $( … ), el comando que rodea la sustitución consume el
        # cuerpo. Solo es texto como valor entre comillas dobles de una opción
        # de mensaje de git o gh (-m "$(cat <<EOF", --body "$(cat <<EOF"); en
        # cualquier otro lugar la salida puede volverse argumentos o código.
        case "$before" in
          *'$('*)
            outer="${before%\$(*}"
            [[ "$outer" =~ $GUARD_MESSAGE_OPTION ]] || skip=0
            guard_tokenize "$(printf '%s' "$outer" | sed -E 's/.*(&&|\|\||[;|`]|\$\()//')"
            outer="${GUARD_TOKENS[$(guard_command_start)]:-}"
            case " $GUARD_TEXT_CONSUMERS " in *" ${outer##*/} "*) ;; *) skip=0 ;; esac
            ;;
        esac
        continue
      fi
      case "$GUARD_SAFE_HEREDOC_SINKS" in
        *" $feeder "*) skip=1 ;;
        *) skip=0 ;;
      esac
      # Pasado por pipe a un intérprete: el cuerpo se ejecuta.
      if [ "$skip" = "1" ] && printf '%s' "$line" \
        | grep -qE '\|[[:space:]]*(sudo[[:space:]]+)?(bash|sh|zsh|ksh|psql|mysql|mariadb|sqlite3|kubectl|helm)\b'; then
        skip=0
      fi
      # Escrito a un archivo: un comando posterior puede ejecutarlo.
      if [ "$skip" = "1" ] && printf '%s' "$line" | grep -qE '>{1,2}[[:space:]]*[^[:space:]]'; then
        skip=0
      fi
      if [ "$skip" = "1" ] && [ "$feeder" = "tee" ] \
        && printf '%s' "$before" | grep -qE 'tee\b([[:space:]]+-[A-Za-z]+)*[[:space:]]+[^[:space:]-]'; then
        skip=0
      fi
      continue
    fi
    out+="$line"$'\n'
  done <<< "$text"
  printf '%s' "$out"
}

# Imprime un segmento por línea: cuerpos de heredoc filtrados (ver
# guard_filter_heredocs; <mode> "executed" deja solo los cuerpos que ejecuta
# un shell) y &&, ||, ;, |, &, backticks y $( partidos en líneas propias.
guard_segments() {
  guard_filter_heredocs "$1" "${2:-}" | sed -E 's/(&&|\|\||[;|&`]|\$\()/\n/g'
}

# Parte un segmento en GUARD_TOKENS, respetando comillas simples y dobles.
# Los paréntesis sin comillas separan tokens, así `(cd x` se lee como `cd x`.
# Un token que tenía un `$` fuera de comillas simples queda registrado en
# GUARD_DYNAMIC_TOKENS (índices separados por espacios).
guard_tokenize() {
  local text="$1" length index character token="" quote="" has_token=0 dynamic=0
  GUARD_TOKENS=()
  GUARD_DYNAMIC_TOKENS=" "
  length=${#text}
  for ((index = 0; index < length; index++)); do
    character="${text:index:1}"
    if [ -n "$quote" ]; then
      if [ "$character" = "$quote" ]; then
        quote=""
      else
        [ "$quote" = '"' ] && [ "$character" = '$' ] && dynamic=1
        token+="$character"
      fi
      continue
    fi
    case "$character" in
      "'" | '"')
        quote="$character"
        has_token=1
        ;;
      ' ' | "$GUARD_TAB" | '(' | ')')
        if [ "$has_token" = "1" ]; then
          [ "$dynamic" = "1" ] && GUARD_DYNAMIC_TOKENS+="${#GUARD_TOKENS[@]} "
          GUARD_TOKENS+=("$token")
        fi
        token="" has_token=0 dynamic=0
        ;;
      *)
        [ "$character" = '$' ] && dynamic=1
        token+="$character"
        has_token=1
        ;;
    esac
  done
  if [ "$has_token" = "1" ]; then
    [ "$dynamic" = "1" ] && GUARD_DYNAMIC_TOKENS+="${#GUARD_TOKENS[@]} "
    GUARD_TOKENS+=("$token")
  fi
}

guard_token_is_dynamic() {
  case "$GUARD_DYNAMIC_TOKENS" in *" $1 "*) return 0 ;; esac
  return 1
}

# Índice del primer token después de los envoltorios y de las asignaciones
# VAR=valor iniciales. Deja GUARD_VIA_XARGS=1 si xargs es uno de los envoltorios.
guard_command_start() {
  local index=0 count=${#GUARD_TOKENS[@]} token
  GUARD_VIA_XARGS=0
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    case "$token" in
      command | nohup | '{' | '!') index=$((index + 1)) ;;
      sudo | env | xargs)
        [ "$token" = "xargs" ] && GUARD_VIA_XARGS=1
        index=$((index + 1))
        # Opciones del envoltorio, y el valor aparte de las que llevan uno.
        while [ "$index" -lt "$count" ]; do
          case "$token:${GUARD_TOKENS[$index]}" in
            sudo:-u | sudo:-g | sudo:-h | sudo:-p | sudo:-C | sudo:-U | sudo:-r | sudo:-t | sudo:-D | sudo:-R | \
              env:-u | env:-C | env:--unset | env:--chdir | \
              xargs:-I | xargs:-n | xargs:-P | xargs:-L | xargs:-s | xargs:-d | xargs:-E | xargs:-a | \
              xargs:--max-args | xargs:--max-procs | xargs:--max-lines | xargs:--max-chars | \
              xargs:--replace | xargs:--delimiter | xargs:--arg-file | xargs:--eof)
              index=$((index + 2))
              ;;
            *:--) index=$((index + 1)); break ;;
            *:-*) index=$((index + 1)) ;;
            *) break ;;
          esac
        done
        ;;
      *=*)
        if [[ "$token" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then index=$((index + 1)); else break; fi
        ;;
      *) break ;;
    esac
  done
  printf '%s' "$index"
}

guard_in_list() {
  local item="$1" list="$2" candidate
  for candidate in $list; do
    [ "$candidate" = "$item" ] && return 0
  done
  return 1
}

guard_physical_directory() {
  (cd "$1" 2>/dev/null && pwd -P)
}

# Imprime la ruta física absoluta de <path> vista desde <cwd>, o retorna 1 si
# no se puede resolver. Una ruta con comodín se resuelve al directorio donde se
# expande el comodín.
guard_resolve_path() {
  local path="$1" cwd="$2" temporary="${TMPDIR:-/tmp}" existing rest="" base component normalized=""
  temporary="${temporary%/}"
  path="${path//\$\{TMPDIR\}/$temporary}"
  path="${path//\$TMPDIR/$temporary}"
  path="${path//\$\{PWD\}/$cwd}"
  path="${path//\$PWD/$cwd}"
  case "$path" in *'$'* | *'`'* | '~'* | *'{'* | *'}'*) return 1 ;; esac
  [ -n "$path" ] || return 1
  case "$path" in
    *'*'* | *'?'* | *'['*)
      path="${path%%[*?[]*}"
      case "$path" in */*) path="${path%/*}" ;; *) path="." ;; esac
      [ -n "$path" ] || path="/"
      ;;
  esac
  case "$path" in /*) ;; *) path="$cwd/$path" ;; esac
  existing="$path"
  while [ ! -d "$existing" ]; do
    rest="$(basename "$existing")${rest:+/$rest}"
    existing="$(dirname "$existing")"
  done
  base="$(guard_physical_directory "$existing")" || return 1
  local IFS=/
  for component in $rest; do
    case "$component" in
      '' | .) ;;
      ..) base="$(dirname "$base")" ;;
      *) base="${base%/}/$component" ;;
    esac
  done
  unset IFS
  normalized="$base"
  printf '%s' "$normalized"
}

guard_is_inside() {
  # $1 estrictamente dentro de $2
  [ "$1" != "$2" ] || return 1
  case "$1/" in "${2%/}/"*) return 0 ;; esac
  return 1
}

guard_is_inside_or_equal() {
  [ "$1" = "$2" ] && return 0
  guard_is_inside "$1" "$2"
}

# Imprime, uno por línea, lo que un borrado dentro del worktree de <cwd> nunca
# debe alcanzar: el git dir, el git dir común, la entrada `.git` de la raíz y
# todo otro worktree anidado en la raíz.
guard_protected_paths() {
  local cwd="$1" toplevel="$2" line worktree
  guard_physical_directory "$(git -C "$cwd" rev-parse --absolute-git-dir 2>/dev/null)"
  printf '\n'
  (cd "$cwd" && guard_physical_directory "$(git rev-parse --git-common-dir 2>/dev/null)")
  printf '\n%s\n' "$toplevel/.git"
  while IFS= read -r line; do
    case "$line" in worktree\ *) ;; *) continue ;; esac
    worktree="$(guard_physical_directory "${line#worktree }")"
    [ -n "$worktree" ] && [ "$worktree" != "$toplevel" ] && guard_is_inside "$worktree" "$toplevel" && printf '%s\n' "$worktree"
  done < <(git -C "$cwd" worktree list --porcelain 2>/dev/null)
}

# Retorna 0 si el shell expandiría <pattern> a <name> (un componente de ruta;
# un punto inicial solo calza con un patrón que empieza con punto).
guard_glob_matches() {
  local name="$1" pattern="$2"
  case "$name" in .*) case "$pattern" in .*) ;; *) return 1 ;; esac ;; esac
  # shellcheck disable=SC2053
  [[ "$name" == $pattern ]]
}

# Retorna 0 si borrar <absolute-path> desde <cwd> es seguro. <mode>:
#   exact          rm de esa ruta: estrictamente dentro de la raíz del
#                  worktree, sin estar dentro de una ruta protegida ni contenerla
#   clean          git clean ahí: la raíz misma también cuenta, y contener una
#                  ruta protegida está bien (git clean se las salta)
#   glob:<pattern> rm de <pattern> expandido en ese directorio: la raíz misma
#                  cuenta, y ninguna ruta protegida puede calzar con <pattern>
# Fuera de un worktree, solo rutas estrictamente dentro de una raíz temporal o extra.
guard_path_is_safe() {
  local path="$1" cwd="$2" mode="$3" toplevel protected component pattern="" roots root
  case "$mode" in glob:*) pattern="${mode#glob:}" ;; esac
  toplevel="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null)"
  [ -n "$toplevel" ] && toplevel="$(guard_physical_directory "$toplevel")"
  if [ -n "$toplevel" ] && { guard_is_inside "$path" "$toplevel" || { [ "$mode" != "exact" ] && [ "$path" = "$toplevel" ]; }; }; then
    while IFS= read -r protected; do
      [ -n "$protected" ] || continue
      guard_is_inside_or_equal "$path" "$protected" && return 1
      case "$mode" in
        exact) guard_is_inside "$protected" "$path" && return 1 ;;
        glob:*)
          if guard_is_inside "$protected" "$path"; then
            component="${protected#"$path"/}"
            guard_glob_matches "${component%%/*}" "$pattern" && return 1
          fi
          ;;
      esac
    done < <(guard_protected_paths "$cwd" "$toplevel")
    return 0
  fi
  roots="${GUARD_TEMP_ROOTS:-${TMPDIR:-}:/tmp:/private/tmp:/private/var/folders}:${GUARD_EXTRA_SAFE_ROOTS:-}"
  local IFS=:
  for root in $roots; do
    [ -n "$root" ] || continue
    root="$(guard_physical_directory "$root")"
    [ -n "$root" ] || continue
    guard_is_inside "$path" "$root" && return 0
  done
  return 1
}

# Expande en el lugar un alias de git en GUARD_TOKENS (un nivel), así `git p`
# con `alias.p = push` se revisa como push. Retorna 1 con GUARD_ALIAS_REASON
# si un alias puede ocultarle un comando a este guard: un alias de shell
# (`!…`), un alias dado con `-c alias.*`, o un `git config` que define uno
# (puede usarse más adelante en el mismo comando, antes de que la config lo tenga).
# Argumentos: índice de inicio de `git`, cwd.
guard_expand_git_alias() {
  local start="$1" directory="$2" index count token subcommand alias_value saved rebuilt=""
  GUARD_ALIAS_REASON=""
  index=$((start + 1))
  count=${#GUARD_TOKENS[@]}
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    case "$token" in
      -C)
        index=$((index + 1))
        case "${GUARD_TOKENS[$index]:-}" in /*) directory="${GUARD_TOKENS[$index]}" ;; *) directory="$directory/${GUARD_TOKENS[$index]:-}" ;; esac
        ;;
      -c)
        index=$((index + 1))
        case "${GUARD_TOKENS[$index]:-}" in
          alias.*)
            GUARD_ALIAS_REASON="git -c alias.* define un alias que este guard no puede seguir"
            return 1
            ;;
        esac
        ;;
      -*) ;;
      *) break ;;
    esac
    index=$((index + 1))
  done
  subcommand="${GUARD_TOKENS[$index]:-}"
  [ -n "$subcommand" ] || return 0
  if [ "$subcommand" = "config" ]; then
    case " ${GUARD_TOKENS[*]:$index} " in
      *" alias."*)
        GUARD_ALIAS_REASON="git config alias.* define un alias que puede ocultarle un push a este guard"
        return 1
        ;;
    esac
    return 0
  fi
  alias_value="$(git -C "$directory" config --get "alias.$subcommand" 2>/dev/null)" || return 0
  case "$alias_value" in
    '!'*)
      GUARD_ALIAS_REASON="git $subcommand es un alias de shell ($alias_value)"
      return 1
      ;;
  esac
  saved=("${GUARD_TOKENS[@]}")
  for ((count = 0; count < ${#saved[@]}; count++)); do
    if [ "$count" -eq "$index" ]; then
      rebuilt+="$alias_value "
    else
      rebuilt+="$(printf '%q' "${saved[$count]}") "
    fi
  done
  guard_tokenize "$rebuilt"
  return 0
}

# Decide un segmento `git push`. Argumentos: índice de inicio de `git`, cwd.
guard_decide_push() {
  local index="$1" cwd="$2" count=${#GUARD_TOKENS[@]} directory="$2" token remote="" positional=()
  local delete=0 refspec destination current protected
  protected="${GUARD_PROTECTED_BRANCHES:-$GUARD_DEFAULT_PROTECTED_BRANCHES} $(guard_repo_list "$directory" protectedBranches)"
  index=$((index + 1))
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    case "$token" in
      -C)
        index=$((index + 1))
        case "${GUARD_TOKENS[$index]:-}" in /*) directory="${GUARD_TOKENS[$index]}" ;; *) directory="$directory/${GUARD_TOKENS[$index]:-}" ;; esac
        ;;
      -c) index=$((index + 1)) ;;
      -*) ;;
      *) break ;;
    esac
    index=$((index + 1))
  done
  [ "${GUARD_TOKENS[$index]:-}" = "push" ] || return 0
  index=$((index + 1))
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    if guard_token_is_dynamic "$index"; then
      printf 'ask%sgit push con un argumento variable (%s): no se puede saber la rama de destino' "$GUARD_TAB" "$token"
      return 0
    fi
    case "$token" in
      --force | --force=* | --force-with-lease | --force-with-lease=* | --force-if-includes)
        printf 'deny%sel push forzado no está permitido (%s)' "$GUARD_TAB" "$token"
        return 0
        ;;
      --all | --mirror)
        printf 'deny%sgit push %s actualizaría ramas protegidas' "$GUARD_TAB" "$token"
        return 0
        ;;
      --delete) delete=1 ;;
      --repo=*) remote="${token#--repo=}" ;;
      -o | --push-option | --receive-pack | --exec) index=$((index + 1)) ;;
      --*) ;;
      -*)
        case "$token" in
          *f*)
            printf 'deny%sel push forzado no está permitido (%s)' "$GUARD_TAB" "$token"
            return 0
            ;;
        esac
        case "$token" in *d*) delete=1 ;; esac
        ;;
      *) positional+=("$token") ;;
    esac
    index=$((index + 1))
  done
  [ -z "$remote" ] && [ "${#positional[@]}" -gt 0 ] && positional=("${positional[@]:1}")
  current="$(git -C "$directory" branch --show-current 2>/dev/null)"
  if [ "${#positional[@]}" -eq 0 ]; then
    [ "$delete" = "1" ] && return 0
    if [ -z "$current" ]; then
      printf 'ask%sgit push sin refspec desde un detached HEAD: no se puede saber la rama de destino' "$GUARD_TAB"
      return 0
    fi
    positional=("$current")
  fi
  for refspec in "${positional[@]}"; do
    case "$refspec" in
      +*)
        printf 'deny%sel push forzado no está permitido (refspec %s)' "$GUARD_TAB" "$refspec"
        return 0
        ;;
    esac
    case "$refspec" in *:*) destination="${refspec##*:}" ;; *) destination="$refspec" ;; esac
    if [ -z "$destination" ]; then
      printf 'deny%sgit push %s hace push de todas las ramas que calzan, incluidas las protegidas' "$GUARD_TAB" "$refspec"
      return 0
    fi
    destination="${destination#refs/heads/}"
    case "$destination" in
      *'*'*)
        printf 'deny%sel refspec con comodín %s puede actualizar ramas protegidas' "$GUARD_TAB" "$refspec"
        return 0
        ;;
    esac
    [ "$destination" = "HEAD" ] && destination="$current"
    if [ -z "$destination" ]; then
      printf 'ask%sgit push HEAD desde un detached HEAD: no se puede saber la rama de destino' "$GUARD_TAB"
      return 0
    fi
    if guard_in_list "$destination" "$protected"; then
      printf 'deny%sel push a la rama protegida %s no está permitido; cambia solo con un PR mergeado' "$GUARD_TAB" "$destination"
      return 0
    fi
  done
  return 0
}

# Decide un segmento `gh pr merge`. Argumentos: índice de inicio de `gh`, cwd.
# Para un comando que corre fuera del sandbox, el shell que abre sus
# redirecciones de salida también está fuera: `> ~/.zshrc` escribiría ahí.
# Imprime "deny<TAB>motivo" si una redirección de salida apunta fuera del
# proyecto y de los temporales (`/dev/null` y `2>&1` pasan). Argumentos:
# índice del comando en GUARD_TOKENS, cwd.
guard_decide_output_redirects() {
  local index="$1" cwd="$2" count=${#GUARD_TOKENS[@]} token target resolved
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    if [[ "$token" =~ ^[0-9]*\>\>?(.*)$ ]]; then
      target="${BASH_REMATCH[1]}"
      if [ -z "$target" ]; then
        index=$((index + 1))
        target="${GUARD_TOKENS[$index]:-}"
      fi
      # Vacío: era `2>&1`, que la partición del comando corta en el `&`.
      case "$target" in
        '' | /dev/null | '&'*) ;;
        *)
          if ! resolved="$(guard_resolve_path "$target" "$cwd")" || ! guard_path_is_safe "$resolved" "$cwd" exact; then
            printf 'deny%suna redirección de salida (%s) escribiría fuera del proyecto, desde un comando que corre fuera del sandbox' "$GUARD_TAB" "$target"
            return 0
          fi
          ;;
      esac
    fi
    index=$((index + 1))
  done
  return 0
}

# Imprime la carpeta git común (física) del repo en <directory>, o nada si no
# es un repo. Un worktree y su checkout principal dan la misma.
guard_common_directory() {
  local common
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 0
  [ -n "$common" ] && guard_physical_directory "$common"
}

# ¿Es <url> una URL de red? (https, http, ssh, git, o la forma `usuario@host:`
# / `host:ruta`). Una ruta local, `file://` o `transporte::` no lo son: con ellas
# git correría los hooks de otro repo, o un programa, fuera del sandbox.
guard_is_network_url() {
  case "$1" in
    *::* | file:*) return 1 ;;
    https://* | http://* | ssh://* | git://*) return 0 ;;
    /* | ./* | ../* | . | .. | '~'*) return 1 ;;
  esac
  [[ "$1" =~ ^[^/:]+:[^/] ]]
}

# git push, fetch y pull corren fuera del sandbox (necesitan la red de
# GitHub). Ahí cualquier opción que ejecute un programa elegido en el mismo
# comando correría con acceso completo: se rechaza. Argumentos: índice de
# `git` en GUARD_TOKENS.
guard_decide_git_network() {
  local start="$1" index=0 count=${#GUARD_TOKENS[@]} token subcommand="" environment="" configuration=""
  local directory="$2" moved_directory=0 repository_option=""
  while [ "$index" -lt "$start" ]; do
    [[ "${GUARD_TOKENS[$index]}" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] && environment="${GUARD_TOKENS[$index]}"
    index=$((index + 1))
  done
  index=$((start + 1))
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    case "$token" in
      -c | --config-env)
        configuration="$token"
        index=$((index + 1))
        ;;
      --config-env=* | --exec-path | --exec-path=*) configuration="$token" ;;
      --git-dir | --work-tree | --namespace)
        repository_option="$token"
        index=$((index + 1))
        ;;
      --git-dir=* | --work-tree=* | --namespace=*) repository_option="$token" ;;
      -C)
        index=$((index + 1))
        moved_directory=1
        case "${GUARD_TOKENS[$index]:-}" in /*) directory="${GUARD_TOKENS[$index]}" ;; *) directory="$directory/${GUARD_TOKENS[$index]:-}" ;; esac
        ;;
      -*) ;;
      *) subcommand="$token"; break ;;
    esac
    index=$((index + 1))
  done
  case "$subcommand" in push | fetch | pull) ;; *) return 0 ;; esac
  # Otro repo trae sus propios hooks y su configuración (core.sshCommand, …),
  # que correrían fuera del sandbox. -C solo vale hacia este mismo repo.
  if [ -n "$repository_option" ]; then
    printf 'deny%sgit %s %s carga otro repo, con sus hooks y su configuración, fuera del sandbox' "$GUARD_TAB" "$repository_option" "$subcommand"
    return 0
  fi
  if [ "$moved_directory" = "1" ] && [ "$(guard_common_directory "$directory")" != "$(guard_common_directory "$2")" ]; then
    printf 'deny%sgit -C hacia otro repo: sus hooks y su configuración correrían fuera del sandbox' "$GUARD_TAB"
    return 0
  fi
  token="$(guard_decide_output_redirects "$start" "$2")"
  if [ -n "$token" ]; then
    printf '%s' "$token"
    return 0
  fi
  if [ -n "$environment" ]; then
    printf 'deny%suna variable de entorno delante de git %s (%s) puede cambiar qué programa corre fuera del sandbox' "$GUARD_TAB" "$subcommand" "$environment"
    return 0
  fi
  if [ "${GUARD_ENVIRONMENT_CHANGED:-0}" = "1" ]; then
    printf 'deny%sel comando cambia el entorno antes de git %s (export, source, …): podría cambiar qué programa corre fuera del sandbox' "$GUARD_TAB" "$subcommand"
    return 0
  fi
  if [ -n "$configuration" ]; then
    printf 'deny%sgit %s %s cambia la configuración de un comando que corre fuera del sandbox' "$GUARD_TAB" "$configuration" "$subcommand"
    return 0
  fi
  local name full remote="" url current
  # El destino: --repo, o el primer argumento que no es una opción, o el
  # remoto de la rama actual (origin por omisión).
  local scan=$((index + 1))
  while [ "$scan" -lt "$count" ]; do
    token="${GUARD_TOKENS[$scan]}"
    case "$token" in
      --repo=*) remote="${token#--repo=}"; break ;;
      --repo | -o | --push-option) scan=$((scan + 1)) ;;
      -*) ;;
      *) remote="$token"; break ;;
    esac
    scan=$((scan + 1))
  done
  if [ -z "$remote" ]; then
    current="$(git -C "$directory" branch --show-current 2>/dev/null)"
    remote="$(git -C "$directory" config --get "branch.$current.remote" 2>/dev/null)"
    [ -n "$remote" ] || remote="origin"
  fi
  if [ "$subcommand" = "push" ]; then
    url="$(git -C "$directory" remote get-url --push "$remote" 2>/dev/null)" || url="$remote"
  else
    url="$(git -C "$directory" remote get-url "$remote" 2>/dev/null)" || url="$remote"
  fi
  if ! guard_is_network_url "$url"; then
    printf 'deny%sgit %s a %s: un repo local o un transporte propio ejecutaría código fuera del sandbox' "$GUARD_TAB" "$subcommand" "$url"
    return 0
  fi
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    # git acepta opciones largas abreviadas (`--upload-p`, `--rec`): una
    # opción cuenta si su nombre es el comienzo de una de las peligrosas.
    name="${token%%=*}"
    case "$name" in
      --?*)
        for full in --receive-pack --upload-pack --exec; do
          case "$full" in
            "$name"*)
              printf 'deny%sgit %s %s ejecutaría un programa fuera del sandbox' "$GUARD_TAB" "$subcommand" "$token"
              return 0
              ;;
          esac
        done
        ;;
    esac
    case "$token" in
      --receive-pack | --receive-pack=* | --upload-pack | --upload-pack=* | --exec | --exec=*)
        printf 'deny%sgit %s %s ejecutaría un programa fuera del sandbox' "$GUARD_TAB" "$subcommand" "$token"
        return 0
        ;;
    esac
    index=$((index + 1))
  done
  return 0
}

# gh pr, gh issue y gh api corren fuera del sandbox. Un archivo que leen
# (--body-file, -F, --input, -F campo=@archivo) tiene que estar dentro del
# proyecto o de un temporal: si no, gh podría subir a GitHub una credencial.
# Argumentos: índice de `gh`, cwd.
guard_decide_gh_files() {
  local index=$(($1 + 1)) cwd="$2" count=${#GUARD_TOKENS[@]} token value group="${GUARD_TOKENS[$(($1 + 1))]:-}" resolved
  local files=()
  value="$(guard_decide_output_redirects "$1" "$cwd")"
  if [ -n "$value" ]; then
    printf '%s' "$value"
    return 0
  fi
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    value=""
    # Una redirección de entrada (`<`, `0<`, `<<<`) la abre el shell, y para
    # un gh fuera del sandbox el shell también está fuera: lee cualquier archivo.
    if [[ "$token" =~ ^[0-9]*\< ]]; then
      printf 'deny%sgh con una redirección de entrada (%s): el shell la abriría fuera del sandbox' "$GUARD_TAB" "$token"
      return 0
    fi
    case "$token" in
      --body-file=* | --input=*) value="${token#*=}" ;;
      --body-file | --input)
        index=$((index + 1))
        value="${GUARD_TOKENS[$index]:-}"
        ;;
      -F | --field)
        index=$((index + 1))
        value="${GUARD_TOKENS[$index]:-}"
        # En gh api, -F campo=@archivo lee el archivo; en pr/issue, -F es --body-file.
        if [ "$group" = "api" ]; then
          case "$value" in *=@*) value="${value#*=@}" ;; *) value="" ;; esac
        fi
        ;;
      --field=* | -F?*)
        # Formas pegadas: --field=…, -F…, -F=…
        case "$token" in --field=*) value="${token#--field=}" ;; *) value="${token#-F}"; value="${value#=}" ;; esac
        if [ "$group" = "api" ]; then
          case "$value" in *=@*) value="${value#*=@}" ;; *) value="" ;; esac
        fi
        ;;
    esac
    [ -n "$value" ] && [ "$value" != "-" ] && files+=("$value")
    index=$((index + 1))
  done
  local file links
  for value in ${files[@]+"${files[@]}"}; do
    case "$value" in /*) file="$value" ;; *) file="$cwd/$value" ;; esac
    # Un symlink o un hard link dentro del proyecto puede apuntar a una
    # credencial: el archivo que gh lee tiene que ser uno común y único.
    # GNU primero: en Linux, `stat -f` es "sistema de archivos" y `%l` sería
    # el largo máximo de nombre. En macOS, `stat -c` falla y pasa a `stat -f`.
    links="$(stat -c %h "$file" 2>/dev/null || stat -f %l "$file" 2>/dev/null)"
    if [ -L "$file" ] || { [ -n "$links" ] && [ "$links" -gt 1 ]; }; then
      printf 'deny%sgh leería un enlace (%s): podría apuntar fuera del proyecto' "$GUARD_TAB" "$value"
      return 0
    fi
    if ! resolved="$(guard_resolve_path "$value" "$cwd")" || ! guard_path_is_safe "$resolved" "$cwd" exact; then
      printf 'deny%sgh leería un archivo fuera del proyecto y de los temporales (%s)' "$GUARD_TAB" "$value"
      return 0
    fi
  done
  return 0
}

# Mutaciones de GraphQL que mueven ramas, crean commits, mergean o cambian las
# protecciones o la configuración del repo: lo mismo que un push o un merge,
# pero sin pasar por las reglas de git push y gh pr merge.
GUARD_GITHUB_DANGEROUS_MUTATIONS='updateRef|updateRefs|createRef|deleteRef|createCommitOnBranch|mergeBranch|mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|updateBranchProtectionRule|deleteBranchProtectionRule|createBranchProtectionRule|updateRepository|updateRepositoryRuleset|deleteRepositoryRuleset|createRepositoryRuleset|archiveRepository|transferRepository|deleteRepository'

# Rutas de REST que, con un método que no es GET, hacen lo mismo: mover o
# crear ramas y commits, cambiar archivos, mergear, tocar protecciones, la
# configuración del repo o sus accesos.
GUARD_GITHUB_DANGEROUS_PATHS='^repos/[^/]+/[^/]+/?$|/git/(refs|commits|trees|blobs|tags)|/contents/|/branches/.+/(protection|rename)|/rulesets|/merges/?$|/pulls/[0-9]+/(merge|update-branch)|/(hooks|keys|collaborators|invitations|transfer|pages|environments)(/|$)|/actions/(secrets|variables|permissions)'

# Decide un `gh api`, que corre fuera del sandbox con tu sesión de GitHub.
# Leer pasa; escribir pasa salvo en lo que se salta las reglas de push y merge.
# Argumentos: índice de `gh` en GUARD_TOKENS.
guard_decide_gh_api() {
  local index=$(($1 + 2)) count=${#GUARD_TOKENS[@]} token method="" writes=0 endpoint=""
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    case "$token" in
      -X | --method)
        index=$((index + 1))
        method="${GUARD_TOKENS[$index]:-}"
        ;;
      -X?*) method="${token#-X}" ;;
      --method=*) method="${token#--method=}" ;;
      -f | -F | --field | --raw-field | --input)
        writes=1
        index=$((index + 1))
        ;;
      -f?* | -F?* | --field=* | --raw-field=* | --input=*) writes=1 ;;
      -H | --header | -q | --jq | -t | --template | --hostname | --cache | -p | --preview) index=$((index + 1)) ;;
      -*) ;;
      *) [ -z "$endpoint" ] && endpoint="$token" ;;
    esac
    index=$((index + 1))
  done
  method="$(printf '%s' "${method:-}" | tr '[:lower:]' '[:upper:]')"
  [ -z "$method" ] && { [ "$writes" = "1" ] && method="POST" || method="GET"; }
  endpoint="${endpoint#/}"
  if [ "$endpoint" = "graphql" ]; then
    if [[ " ${GUARD_TOKENS[*]:$1} " =~ (^|[^A-Za-z])($GUARD_GITHUB_DANGEROUS_MUTATIONS)([^A-Za-z]|$) ]]; then
      printf 'deny%sgh api graphql con %s: mueve ramas, mergea o cambia el repo sin pasar por git push ni gh pr merge' "$GUARD_TAB" "${BASH_REMATCH[2]}"
    fi
    return 0
  fi
  [ "$method" = "GET" ] && return 0
  if [[ "$endpoint" =~ $GUARD_GITHUB_DANGEROUS_PATHS ]]; then
    printf 'deny%sgh api %s %s: mueve ramas, mergea o cambia el repo sin pasar por git push ni gh pr merge' "$GUARD_TAB" "$method" "$endpoint"
  fi
  return 0
}

guard_decide_merge() {
  local index=$(($1 + 3)) cwd="$2" count=${#GUARD_TOKENS[@]} token merge=0 target="" repository="" base
  local allowed="" candidate character position
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    case "$token" in
      --merge) merge=1 ;;
      --squash | --rebase | --admin)
        printf 'deny%sgh pr merge %s no está permitido: mergea con --merge (merge commit) y sin --admin' "$GUARD_TAB" "$token"
        return 0
        ;;
      --repo=*) repository="${token#--repo=}" ;;
      -R | --repo)
        index=$((index + 1))
        repository="${GUARD_TOKENS[$index]:-}"
        ;;
      -b | --body | -t | --subject | -F | --body-file | -A | --author-email | --match-head-commit) index=$((index + 1)) ;;
      --*) ;;
      -*)
        for ((position = 1; position < ${#token}; position++)); do
          character="${token:position:1}"
          case "$character" in
            m) merge=1 ;;
            s | r)
              printf 'deny%sgh pr merge %s no está permitido: mergea con --merge (merge commit)' "$GUARD_TAB" "$token"
              return 0
              ;;
            b | t | F | A | R)
              if [ "$position" -eq $((${#token} - 1)) ]; then
                index=$((index + 1))
                [ "$character" = "R" ] && repository="${GUARD_TOKENS[$index]:-}"
              else
                [ "$character" = "R" ] && repository="${token:position+1}"
              fi
              break
              ;;
          esac
        done
        ;;
      *) [ -z "$target" ] && target="$token" ;;
    esac
    index=$((index + 1))
  done
  if [ "$merge" != "1" ]; then
    printf 'deny%sgh pr merge sin --merge no está permitido: los merges siempre son merge commits' "$GUARD_TAB"
    return 0
  fi
  # mergeBases amplía lo que pasa sin preguntar, así que no sale de la copia
  # que el agente puede editar: sale de la versión commiteada en la rama de
  # release. Y solo vale para este repo: con -R/--repo se ignora.
  for candidate in ${GUARD_MERGE_BASES:-} $([ -z "$repository" ] && guard_committed_repo_list "$cwd" mergeBases); do
    guard_in_list "$candidate" "$GUARD_RELEASE_BRANCHES" || allowed+="$candidate "
  done
  base="$(cd "$cwd" 2>/dev/null && gh pr view ${target:+"$target"} ${repository:+--repo "$repository"} --json baseRefName -q .baseRefName 2>/dev/null)"
  if [ -z "$base" ]; then
    printf 'ask%sno se pudo resolver la rama base del PR que se mergea' "$GUARD_TAB"
    return 0
  fi
  guard_in_list "$base" "$allowed" && return 0
  printf 'ask%sel merge a %s necesita el OK de una persona' "$GUARD_TAB" "$base"
}

# Decide un segmento rm o git clean. Argumentos: índice de inicio, cwd, si
# corrió un cd antes en el comando, si el comando tiene sustituciones.
guard_decide_delete() {
  local index="$1" cwd="$2" moved="$3" substituted="$4" count=${#GUARD_TOKENS[@]} token kind destructive=0 options=1
  local directory="$2" paths=() path resolved mode literal prefix pattern
  if [ "${GUARD_TOKENS[$index]}" = "rm" ]; then
    kind=rm
    index=$((index + 1))
  else
    kind=clean
    index=$((index + 1))
    while [ "$index" -lt "$count" ]; do
      token="${GUARD_TOKENS[$index]}"
      case "$token" in
        -C)
          index=$((index + 1))
          case "${GUARD_TOKENS[$index]:-}" in /*) directory="${GUARD_TOKENS[$index]}" ;; *) directory="$directory/${GUARD_TOKENS[$index]:-}" ;; esac
          ;;
        -c) index=$((index + 1)) ;;
        -*) ;;
        *) break ;;
      esac
      index=$((index + 1))
    done
    [ "${GUARD_TOKENS[$index]:-}" = "clean" ] || return 0
    index=$((index + 1))
  fi
  while [ "$index" -lt "$count" ]; do
    token="${GUARD_TOKENS[$index]}"
    case "$token" in
      '>' | '>>' | '<' | [0-9]'>' | [0-9]'>>' | [0-9]'<')
        index=$((index + 2))
        continue
        ;;
    esac
    if [ "$options" = "1" ]; then
      case "$token" in
        --) options=0; index=$((index + 1)); continue ;;
        --recursive | --force) destructive=1 ;;
        -e | --exclude) [ "$kind" = "clean" ] && index=$((index + 1)) ;;
        --*) ;;
        -*)
          case "$kind:$token" in
            clean:*[xX]*)
              printf 'ask%sgit clean %s también borra archivos ignorados, como .env' "$GUARD_TAB" "$token"
              return 0
              ;;
            rm:*[rRf]* | clean:*f*) destructive=1 ;;
          esac
          ;;
        *[\<\>]*) ;;
        *) paths+=("$index") ;;
      esac
    else
      paths+=("$index")
    fi
    index=$((index + 1))
  done
  [ "$destructive" = "1" ] || return 0
  if [ "$substituted" = "1" ] || [ "$GUARD_VIA_XARGS" = "1" ]; then
    printf 'ask%s%s con rutas armadas en tiempo de ejecución (sustitución o xargs)' "$GUARD_TAB" "$kind"
    return 0
  fi
  if [ "${#paths[@]}" -eq 0 ]; then
    if [ "$kind" = "rm" ]; then
      printf 'ask%srm sin una ruta visible' "$GUARD_TAB"
      return 0
    fi
    if [ "$moved" = "1" ]; then
      printf 'ask%sgit clean después de cd: no se puede saber el directorio' "$GUARD_TAB"
      return 0
    fi
    resolved="$(guard_resolve_path "$directory" "$cwd")" && guard_path_is_safe "$resolved" "$cwd" clean && return 0
    printf 'ask%sgit clean fuera del worktree (%s)' "$GUARD_TAB" "$directory"
    return 0
  fi
  for index in "${paths[@]}"; do
    path="${GUARD_TOKENS[$index]}"
    if guard_token_is_dynamic "$index" && ! [[ "$path" =~ $GUARD_KNOWN_VARIABLE_PATH ]]; then
      printf 'ask%s%s con una ruta con variable (%s)' "$GUARD_TAB" "$kind" "$path"
      return 0
    fi
    case "$path" in
      /* | '$'*) ;;
      *)
        if [ "$moved" = "1" ]; then
          printf 'ask%s%s con una ruta relativa después de cd (%s)' "$GUARD_TAB" "$kind" "$path"
          return 0
        fi
        ;;
    esac
    if ! resolved="$(guard_resolve_path "$path" "$directory")"; then
      printf 'ask%s%s con una ruta que no se puede resolver (%s)' "$GUARD_TAB" "$kind" "$path"
      return 0
    fi
    mode=exact
    [ "$kind" = "clean" ] && mode=clean
    case "$path" in
      *'*'* | *'?'* | *'['*)
        literal="${path%%[*?[]*}"
        prefix=""
        case "$literal" in */*) prefix="${literal%/*}/" ;; esac
        pattern="${path#"$prefix"}"
        mode="glob:${pattern%%/*}"
        ;;
    esac
    if ! guard_path_is_safe "$resolved" "$cwd" "$mode"; then
      printf 'ask%s%s fuera del worktree y de los directorios temporales (%s)' "$GUARD_TAB" "$kind" "$path"
      return 0
    fi
  done
  return 0
}

# Imprime "ask<TAB>motivo" si una sustitución de comando ($( … ) o backticks)
# arma el subcomando de git o gh, o los argumentos de git push, gh pr merge o
# gh api: el guard no puede ver a qué se expanden. Otros usos
# (git commit -m "$(…)", git log --since="$(date)") no imprimen nada.
guard_decide_substitutions() {
  local line consumed rest before_dollar before_backtick prefix index count token subcommand action
  while IFS= read -r line; do
    consumed="" rest="$line"
    while :; do
      before_dollar="${rest%%\$(*}"
      before_backtick="${rest%%\`*}"
      [ "$before_dollar" = "$rest" ] && [ "$before_backtick" = "$rest" ] && break
      if [ "$before_dollar" != "$rest" ] && { [ "$before_backtick" = "$rest" ] || [ "${#before_dollar}" -le "${#before_backtick}" ]; }; then
        prefix="$before_dollar"
        rest="${rest:$((${#prefix} + 2))}"
      else
        prefix="$before_backtick"
        rest="${rest:$((${#prefix} + 1))}"
      fi
      consumed+="$prefix"
      guard_tokenize "$(printf '%s' "$consumed" | sed -E 's/.*(&&|\|\||[;|`]|\$\()//')"
      consumed+='$('
      index="$(guard_command_start)"
      count=${#GUARD_TOKENS[@]}
      token="${GUARD_TOKENS[$index]:-}"
      case "${token##*/}" in
        git)
          subcommand=""
          index=$((index + 1))
          while [ "$index" -lt "$count" ]; do
            token="${GUARD_TOKENS[$index]}"
            case "$token" in
              -C | -c) index=$((index + 1)) ;;
              -*) ;;
              *) subcommand="$token"; break ;;
            esac
            index=$((index + 1))
          done
          case "$subcommand" in
            '' | push)
              printf 'ask%sgit %s con argumentos armados por una sustitución de comando' "$GUARD_TAB" "${subcommand:-<subcommand>}"
              return 0
              ;;
          esac
          ;;
        gh)
          subcommand="${GUARD_TOKENS[$((index + 1))]:-}"
          action="${GUARD_TOKENS[$((index + 2))]:-}"
          case "$subcommand:$action" in
            : | pr: | pr:merge | api:*)
              printf 'ask%sgh %s %s con argumentos armados por una sustitución de comando' "$GUARD_TAB" "${subcommand:-<command>}" "$action"
              return 0
              ;;
          esac
          ;;
      esac
    done
  done <<< "$1"
}

# Imprime "deny<TAB>motivo", "ask<TAB>motivo" o nada para <command> corrido en
# <cwd>. Se revisa cada segmento; deny gana sobre ask.
guard_decide() {
  local command="$1" cwd="$2" segments segment start word decision first_ask="" moved=0 substituted=0 filtered
  filtered="$(guard_filter_heredocs "$command" executed)"
  case "$filtered" in *'$('* | *'`'*) substituted=1 ;; esac
  [ "$substituted" = "1" ] && first_ask="$(guard_decide_substitutions "$filtered")"
  segments="$(guard_segments "$command" executed)"
  # ¿Alguna parte del comando cambia el entorno de las que siguen? (export,
  # declare -x, set -a, source, eval, o una asignación suelta). Si sí, un gh,
  # kubectl, helm o git de red del mismo comando podría correr fuera del
  # sandbox con una variable que cambia qué programa ejecuta.
  GUARD_ENVIRONMENT_CHANGED=0
  local only_assignments
  while IFS= read -r segment; do
    guard_tokenize "$segment"
    [ "${#GUARD_TOKENS[@]}" -gt 0 ] || continue
    case "${GUARD_TOKENS[0]}" in
      export | declare | typeset | readonly | local | set | source | . | eval) GUARD_ENVIRONMENT_CHANGED=1 ;;
    esac
    only_assignments=1
    for token in "${GUARD_TOKENS[@]}"; do
      [[ "$token" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || only_assignments=0
    done
    [ "$only_assignments" = "1" ] && GUARD_ENVIRONMENT_CHANGED=1
  done <<< "$segments"
  while IFS= read -r segment; do
    guard_tokenize "$segment"
    [ "${#GUARD_TOKENS[@]}" -gt 0 ] || continue
    start="$(guard_command_start)"
    word="${GUARD_TOKENS[$start]:-}"
    # `/bin/rm` y `\rm` corren el mismo rm.
    word="${word#\\}"
    word="${word##*/}"
    [ -n "$word" ] && GUARD_TOKENS[$start]="$word"
    decision=""
    # gh, kubectl y helm corren fuera del sandbox. Una variable de entorno
    # delante (GH_PAGER, GH_BROWSER, KUBECONFIG, …), o `env`, puede cambiar
    # qué programa corren o qué credencial usan.
    case "$word" in
      gh | kubectl | helm)
        if [[ " ${GUARD_TOKENS[*]:0:$start} " =~ [[:space:]]([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*|env)[[:space:]] ]]; then
          decision="deny${GUARD_TAB}una variable de entorno delante de $word (${BASH_REMATCH[1]}) puede cambiar qué programa corre fuera del sandbox"
        elif [ "$GUARD_ENVIRONMENT_CHANGED" = "1" ]; then
          decision="deny${GUARD_TAB}el comando cambia el entorno antes de $word (export, source, …): podría cambiar qué programa corre fuera del sandbox"
        fi
        ;;
    esac
    [ -n "$decision" ] && word=""
    case "$word" in
      cd | pushd | popd) moved=1 ;;
      git)
        decision="$(guard_decide_git_network "$start" "$cwd")"
        if [ -z "$decision" ] && ! guard_expand_git_alias "$start" "$cwd"; then
          decision="ask${GUARD_TAB}${GUARD_ALIAS_REASON}"
        fi
        [ -z "$decision" ] && case " ${GUARD_TOKENS[*]:$start} " in
          *" push "*) decision="$(guard_decide_push "$start" "$cwd")" ;;
          *" clean "*) decision="$(guard_decide_delete "$start" "$cwd" "$moved" "$substituted")" ;;
        esac
        ;;
      gh)
        decision="$(guard_decide_gh_files "$start" "$cwd")"
        if [ -n "$decision" ]; then
          :
        elif [ "${GUARD_TOKENS[$((start + 1))]:-}" = "pr" ] && [ "${GUARD_TOKENS[$((start + 2))]:-}" = "merge" ]; then
          decision="$(guard_decide_merge "$start" "$cwd")"
        elif [ "${GUARD_TOKENS[$((start + 1))]:-}" = "api" ]; then
          decision="$(guard_decide_gh_api "$start")"
        fi
        ;;
      rm) decision="$(guard_decide_delete "$start" "$cwd" "$moved" "$substituted")" ;;
    esac
    case "$decision" in
      deny"$GUARD_TAB"*)
        printf '%s' "$decision"
        return 0
        ;;
      ask"$GUARD_TAB"*) [ -z "$first_ask" ] && first_ask="$decision" ;;
    esac
  done <<< "$segments"
  [ -n "$first_ask" ] && printf '%s' "$first_ask"
  return 0
}

# Imprime el JSON de PreToolUse para <decision> (deny|ask). Con
# CLAUDE_NIGHT_SHIFT=1 un ask pasa a deny.
guard_emit() {
  local decision="$1" reason="$2" command="$3" script="$4"
  if [ "$decision" = "ask" ] && [ "${CLAUDE_NIGHT_SHIFT:-}" = "1" ]; then
    decision="deny"
    reason="turno nocturno: nadie puede responder, $reason"
  fi
  jq -n --arg decision "$decision" --arg reason "$script: $reason" --arg command "$command" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: $decision,
      permissionDecisionReason: ($reason + "\nComando: " + $command)
    }
  }'
}

# Lee la entrada del hook desde stdin; sale con 2 si no se puede inspeccionar.
guard_main() {
  local input tool_name command cwd result
  input="$(cat)"
  if ! command -v jq >/dev/null 2>&1; then
    echo "[guard-git-fs] jq no está instalado; se bloquea porque no se puede inspeccionar el comando." >&2
    exit 2
  fi
  if ! tool_name="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)"; then
    echo "[guard-git-fs] no se pudo interpretar la entrada del hook; se bloquea." >&2
    exit 2
  fi
  [ "$tool_name" = "Bash" ] || exit 0
  command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty')"
  [ -n "$command" ] || exit 0
  cwd="$(printf '%s' "$input" | jq -r '.cwd // empty')"
  [ -n "$cwd" ] || cwd="$PWD"
  result="$(guard_decide "$command" "$cwd")"
  [ -n "$result" ] || exit 0
  guard_emit "${result%%"$GUARD_TAB"*}" "${result#*"$GUARD_TAB"}" "$command" "guard-git-fs.sh"
  exit 0
}

# Sin -u: bash 3.2 (/bin/bash de macOS) trata un array vacío como no definido.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  set -o pipefail
  guard_main
fi
