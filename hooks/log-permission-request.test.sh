#!/usr/bin/env bash
# Tests de hooks/log-permission-request.sh (hook PermissionRequest).
# El repo es uno falso en un directorio temporal, con un worktree vinculado:
# las preguntas de los dos tienen que caer en el mismo archivo, fuera del repo.
#
#   bash hooks/log-permission-request.test.sh
#   GUARD_BASH=/bin/bash bash hooks/log-permission-request.test.sh
set -u

cd "$(dirname "$0")/.." || exit 1
unset BASH_ENV
HOOK="$PWD/hooks/log-permission-request.sh"
SHELL_UNDER_TEST="${GUARD_BASH:-bash}"

failures=0
assert_eq() {
  if [ "$2" = "$3" ]; then printf 'ok    %s\n' "$1"; else
    printf 'FALLA %s\n      esperado: [%s]\n      obtenido: [%s]\n' "$1" "$3" "$2"
    failures=$((failures + 1))
  fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tmp=$(cd "$tmp" && pwd -P)
repo="$tmp/repo"
git init -q -b main "$repo"
git -C "$repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git -C "$repo" worktree add -q "$tmp/otro" -b otro
logs="$tmp/state/claude-perimeter/permission-requests"

# Corre el hook con <input JSON> y deja la salida estándar en $tmp/stdout.
run_hook() {
  printf '%s' "$1" | XDG_STATE_HOME="$tmp/state" "$SHELL_UNDER_TEST" "$HOOK" >"$tmp/stdout"
}
request() {
  jq -nc --arg cwd "$1" --arg tool "$2" --argjson input "$3" \
    '{session_id: "s1", hook_event_name: "PermissionRequest", cwd: $cwd, tool_name: $tool, tool_input: $input}'
}
repo_log() { ls "$logs"/repo-*.jsonl 2>/dev/null | head -1; }

run_hook "$(request "$repo" Bash '{"command":"docker ps"}')"
assert_eq 'exit 0' "$?" 0
assert_eq 'sin salida estándar' "$(cat "$tmp/stdout")" ''
log="$(repo_log)"
assert_eq 'el archivo vive fuera del repo, nombrado por el repo' "$(dirname "$log")" "$logs"
assert_eq 'nada se escribe dentro de .git' "$(ls "$repo/.git" | grep -c permission)" 0
assert_eq 'Bash: detail es el comando' "$(tail -1 "$log" | jq -r .detail)" 'docker ps'
assert_eq 'Bash: tool_name' "$(tail -1 "$log" | jq -r .tool_name)" 'Bash'
assert_eq 'session_id, repo y cwd' "$(tail -1 "$log" | jq -r '.session_id + " " + .repo + " " + .cwd')" "s1 $repo $repo"
assert_eq 'time en formato ISO' "$(tail -1 "$log" | jq -r '.time | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T")')" true
assert_eq 'la carpeta queda con permisos 700' "$(ls -ld "$logs" | cut -c1-10)" 'drwx------'
assert_eq 'el archivo queda con permisos 600' "$(ls -l "$log" | cut -c1-10)" '-rw-------'

run_hook "$(request "$repo" Edit '{"file_path":"/x/y.ts","old_string":"a","new_string":"b"}')"
assert_eq 'Edit: detail es el file_path' "$(tail -1 "$log" | jq -r .detail)" '/x/y.ts'

run_hook "$(request "$repo" mcp__x__y '{"query":"hola","limit":3}')"
assert_eq 'MCP: detail es el tool_input compacto' "$(tail -1 "$log" | jq -r .detail)" '{"query":"hola","limit":3}'

run_hook "$(request "$tmp/otro" Bash '{"command":"curl https://example.com"}')"
assert_eq 'desde el worktree cae en el archivo del principal' "$(tail -1 "$log" | jq -r .detail)" 'curl https://example.com'
assert_eq 'cuatro líneas, todas JSON válido' "$(jq -c . "$log" | wc -l | tr -d ' ')" 4

run_hook "$(request / Bash '{"command":"ls"}')"
assert_eq 'fuera de un repo va a no-repo.jsonl' "$(jq -r .detail "$logs/no-repo.jsonl")" 'ls'

run_hook 'no es json'
assert_eq 'JSON inválido → exit 0' "$?" 0
assert_eq 'JSON inválido → sin salida' "$(cat "$tmp/stdout")" ''
assert_eq 'JSON inválido no escribe' "$(wc -l <"$log" | tr -d ' ')" 4

# El ataque: reemplazar el archivo por un symlink a un archivo que tu shell ejecuta.
printf 'original\n' >"$tmp/victim"
rm -f "$log"
ln -s "$tmp/victim" "$log"
run_hook "$(request "$repo" Bash '{"command":"echo pwned"}')"
assert_eq 'no escribe a través de un symlink' "$(cat "$tmp/victim")" 'original'

if [ "$failures" -gt 0 ]; then
  printf '\n%s falla(s)\n' "$failures"
  exit 1
fi
printf '\nTodo ok\n'
