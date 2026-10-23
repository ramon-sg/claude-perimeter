#!/usr/bin/env bash
# PermissionRequest hook: anota cada pregunta de permisos que Claude Code le
# hace a la persona, para saber qué frena el trabajo. No decide nada: nunca
# imprime a stdout y siempre sale con 0, así un fallo al escribir no bloquea la
# herramienta.
#
# Una línea JSON por pregunta: time, session_id, repo, cwd, tool_name y detail
# (el comando en Bash, el file_path en herramientas de archivos, el tool_input
# compacto en el resto).
#
# Dónde: ${XDG_STATE_HOME:-$HOME/.local/state}/claude-guard/permission-requests/,
# un archivo por repo (<carpeta>-<hash>.jsonl), el mismo para el checkout
# principal y todos sus worktrees. Fuera de un repo, no-repo.jsonl.
#
# Por qué ahí y no dentro del repo: este hook corre fuera del sandbox, con tu
# acceso completo. Si escribiera en una carpeta que el agente puede tocar (como
# .git del checkout principal), bastaría con reemplazar el archivo por un
# symlink a ~/.zshrc para que el hook escribiera ahí texto que el agente
# controla. Esta carpeta queda fuera de lo que el sandbox deja escribir, se crea
# con permisos 700 y el hook se niega a escribir a través de un enlace.
#
# Leerlo, de lo más frecuente a lo menos:
#   jq -r '.tool_name + " " + .detail' ~/.local/state/claude-guard/permission-requests/*.jsonl \
#     | sort | uniq -c | sort -rn

input="$(cat)"
command -v jq >/dev/null 2>&1 || exit 0

cwd="$(printf '%s' "$input" | jq -r '.cwd // empty' 2>/dev/null)"
common_directory="$(cd "${cwd:-.}" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
repository=""
name="no-repo"
if [ -n "$common_directory" ]; then
  repository="$(dirname "$common_directory")"
  hash="$(printf '%s' "$common_directory" | { shasum -a 256 2>/dev/null || sha256sum; } | cut -c1-8)"
  name="$(printf '%s' "$(basename "$repository")" | tr -c 'A-Za-z0-9._-' '_')-$hash"
fi

line="$(printf '%s' "$input" | jq -c --arg time "$(date -u +%Y-%m-%dT%H:%M:%SZ)" --arg repository "$repository" '{
  time: $time,
  session_id: (.session_id // ""),
  repo: $repository,
  cwd: (.cwd // ""),
  tool_name: (.tool_name // ""),
  detail: (.tool_input.command // .tool_input.file_path // (.tool_input | tojson))
}' 2>/dev/null)" || exit 0
[ -n "$line" ] || exit 0

directory="${XDG_STATE_HOME:-$HOME/.local/state}/claude-guard/permission-requests"
(umask 077 && mkdir -p "$directory") 2>/dev/null || exit 0
# Ni la carpeta ni el archivo pueden ser enlaces: el hook escribiría donde apuntan.
for part in "$directory" "$(dirname "$directory")"; do
  [ -L "$part" ] && exit 0
done
log="$directory/$name.jsonl"
[ -L "$log" ] && exit 0
(umask 077 && printf '%s\n' "$line" >>"$log") 2>/dev/null
exit 0
