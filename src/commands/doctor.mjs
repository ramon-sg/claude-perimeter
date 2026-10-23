import { machineChecks } from '../checks/machine.mjs';
import { repoChecks } from '../checks/repo.mjs';
import { platformName, userHome } from '../platform.mjs';
import { hasCriticalFailures, hasFailures, renderReport } from '../report.mjs';

/**
 * `claude-perimeter doctor`: revisa la máquina y el repo, y dice qué falta.
 * No cambia nada. Sale con código 1 si hay algún problema; con `critical`,
 * solo si falla algo que deja al agente sin barandas (para scripts que deciden
 * si arrancar una sesión desatendida).
 *
 * @param {{ repoOnly?: boolean, machineOnly?: boolean, explain?: boolean, json?: boolean, offline?: boolean, critical?: boolean }} options
 */
export const doctor = (options) => {
  const platform = process.platform;
  const groups = [];
  if (!options.repoOnly) {
    groups.push({ title: `Máquina (${platformName(platform)})`, checks: machineChecks({ platform, home: userHome() }) });
  }
  if (!options.machineOnly) {
    groups.push({ title: 'Repo', checks: repoChecks({ cwd: process.cwd(), offline: options.offline }) });
  }
  const checks = groups.flatMap((group) => group.checks);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(groups, null, 2)}\n`);
  } else {
    const color = process.stdout.isTTY && !process.env.NO_COLOR;
    process.stdout.write(`claude-perimeter doctor\n${renderReport(groups, { color, explain: options.explain })}\n`);
  }
  return (options.critical ? hasCriticalFailures(checks) : hasFailures(checks)) ? 1 : 0;
};
