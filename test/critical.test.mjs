import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateManagedSettings } from '../src/managed-settings.mjs';
import { CRITICAL_CHECK_IDS, hasCriticalFailures } from '../src/report.mjs';

const source = (file) =>
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', file), 'utf8');

describe('CRITICAL_CHECK_IDS', () => {
  // Un id mal escrito haría que --critical deje pasar justo ese check.
  it('cada id crítico lo produce algún check', () => {
    const produced = new Set(evaluateManagedSettings({}).map((rule) => rule.id));
    const code = source('checks/machine.mjs') + source('checks/safety-net.mjs');
    const dynamic = { 'hook-guard-git.sh': "'guard-git.sh'", 'linux-bubblewrap': "'bubblewrap'", 'linux-socat': "'socat'" };
    for (const id of CRITICAL_CHECK_IDS) {
      const found = produced.has(id) || code.includes(`'${id}'`) || (id in dynamic && code.includes(dynamic[id]));
      assert.ok(found, id);
    }
  });

  it('las piezas del sandbox, Safety Net y el guardia son críticas; el registro no', () => {
    for (const rule of evaluateManagedSettings({})) {
      assert.equal(CRITICAL_CHECK_IDS.has(rule.id), rule.id !== 'permission-log-hook', rule.id);
    }
  });
});

describe('hasCriticalFailures', () => {
  it('una falla de Docker o del repo no cuenta; una del sandbox sí', () => {
    assert.equal(hasCriticalFailures([{ id: 'docker-provider', status: 'fail' }, { id: 'sandbox-enabled', status: 'ok' }]), false);
    assert.equal(hasCriticalFailures([{ id: 'sandbox-enabled', status: 'fail' }]), true);
    assert.equal(hasCriticalFailures([{ id: 'safety-net-probe', status: 'warn' }]), false);
  });
});
