/**
 * @typedef {{ id: string, status: 'ok' | 'fail' | 'warn' | 'skip', title: string, detail?: string, fix?: string }} Check
 */

const SYMBOLS = { ok: '✓', fail: '✗', warn: '⚠', skip: '–' };
const COLORS = { ok: '32', fail: '31', warn: '33', skip: '90' };

/**
 * Arma el texto del doctor: un bloque por grupo, una línea por check y, en los
 * que fallan, qué hacer.
 *
 * @param {{ title: string, checks: Check[] }[]} groups
 * @param {{ color?: boolean, explain?: boolean }} [options]
 * @returns {string}
 */
export const renderReport = (groups, { color = false, explain = false } = {}) => {
  const paint = (status, text) => (color ? `\u001b[${COLORS[status]}m${text}\u001b[0m` : text);
  const lines = [];
  for (const group of groups) {
    lines.push('', group.title);
    for (const check of group.checks) {
      lines.push(`  ${paint(check.status, SYMBOLS[check.status])} ${check.title}`);
      const showDetail = check.detail && (explain || check.status === 'fail');
      if (showDetail) lines.push(`      ${check.detail}`);
      if (check.fix && check.status !== 'ok') lines.push(`      → ${check.fix}`);
    }
  }
  const all = groups.flatMap((group) => group.checks);
  const failures = all.filter((check) => check.status === 'fail').length;
  const warnings = all.filter((check) => check.status === 'warn').length;
  lines.push('');
  if (failures === 0 && warnings === 0) {
    lines.push(paint('ok', 'Todo en orden.'));
  } else {
    const parts = [];
    if (failures > 0) parts.push(paint('fail', `${failures} ${failures === 1 ? 'problema' : 'problemas'}`));
    if (warnings > 0) parts.push(paint('warn', `${warnings} ${warnings === 1 ? 'aviso' : 'avisos'}`));
    lines.push(parts.join(', ') + (explain ? '.' : '. Más detalle: claude-perimeter doctor --explain'));
  }
  return lines.join('\n');
};

/** @param {Check[]} checks @returns {boolean} si hay algún problema. */
export const hasFailures = (checks) => checks.some((check) => check.status === 'fail');
