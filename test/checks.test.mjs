import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { dockerProvider, evaluateFileSharing } from '../src/checks/docker.mjs';
import { broadAllowRules, evaluateBranchRules, parseGithubRemote } from '../src/checks/repo.mjs';
import { buildConfig, describeConfig, parseBranchList, suggestedMergeBases } from '../src/commands/init.mjs';
import { renderReport } from '../src/report.mjs';

describe('dockerProvider', () => {
  it('reconoce cada proveedor por contexto o por socket', () => {
    assert.equal(dockerProvider('orbstack', 'unix:///Users/ana/.orbstack/run/docker.sock'), 'orbstack');
    assert.equal(dockerProvider('default', 'unix:///Users/ana/.orbstack/run/docker.sock'), 'orbstack');
    assert.equal(dockerProvider('desktop-linux', 'unix:///Users/ana/.docker/run/docker.sock'), 'docker-desktop');
    assert.equal(dockerProvider('colima', 'unix:///Users/ana/.colima/default/docker.sock'), 'colima');
    assert.equal(dockerProvider('remoto', 'tcp://10.0.0.1:2376'), 'other');
  });
});

describe('evaluateFileSharing', () => {
  it('falla si /Users, el home o / están compartidos', () => {
    assert.deepEqual(evaluateFileSharing(['/Users', '/tmp'], '/Users/ana'), { ok: false, exposing: ['/Users'] });
    assert.equal(evaluateFileSharing(['/Users/ana'], '/Users/ana').ok, false);
    assert.equal(evaluateFileSharing(['/'], '/Users/ana').ok, false);
  });

  it('pasa si solo se comparten carpetas de proyectos', () => {
    assert.deepEqual(evaluateFileSharing(['/Users/ana/Projects', '/tmp', '/private'], '/Users/ana'), { ok: true, exposing: [] });
  });

  it('no confunde un prefijo de nombre con una carpeta padre', () => {
    assert.equal(evaluateFileSharing(['/Users/an'], '/Users/ana').ok, true);
  });
});

describe('broadAllowRules', () => {
  it('detecta intérpretes, shells, Docker y kubectl sin acotar', () => {
    const rules = [
      'Bash(*)',
      'Bash(python3 *)',
      'Bash(bash:*)',
      'Bash(docker *)',
      'Bash(kubectl *)',
      'Bash(curl *)',
      'Bash(node -e:*)',
      'Bash(python3 -c *)',
    ];
    assert.deepEqual(broadAllowRules(rules), rules);
  });

  it('deja pasar reglas acotadas', () => {
    assert.deepEqual(broadAllowRules(['Bash(pnpm test *)', 'Bash(kubectl get *)', 'Bash(git status)', 'Read(//tmp/**)']), []);
  });
});

describe('parseGithubRemote', () => {
  it('lee https y ssh', () => {
    assert.deepEqual(parseGithubRemote('https://github.com/rsat/cleanqueen.git'), { owner: 'rsat', name: 'cleanqueen' });
    assert.deepEqual(parseGithubRemote('git@github.com:ramon-sg/claude-guard.git'), { owner: 'ramon-sg', name: 'claude-guard' });
    assert.deepEqual(parseGithubRemote('https://github.com/a/b'), { owner: 'a', name: 'b' });
  });

  it('ignora otros hosts', () => {
    assert.equal(parseGithubRemote('https://gitlab.com/a/b.git'), undefined);
  });
});

describe('evaluateBranchRules', () => {
  it('exige PR y bloqueo de force push para dar la rama por protegida', () => {
    assert.deepEqual(evaluateBranchRules([{ type: 'pull_request' }, { type: 'non_fast_forward' }], false), {
      noDirectPush: true,
      noForcePush: true,
      protectedSomehow: true,
    });
    assert.equal(evaluateBranchRules([{ type: 'deletion' }], true).noForcePush, false);
    assert.equal(evaluateBranchRules([], false).protectedSomehow, false);
  });
});

describe('suggestedMergeBases', () => {
  it('sugiere staging y nunca una rama de release', () => {
    assert.deepEqual(suggestedMergeBases(['main', 'staging', 'feat/x', 'production', 'HEAD']), ['staging']);
  });
});

describe('parseBranchList', () => {
  it('separa por comas o espacios y quita repetidas', () => {
    assert.deepEqual(parseBranchList('qa, release/1.0  qa'), { branches: ['qa', 'release/1.0'], invalid: [] });
    assert.deepEqual(parseBranchList(''), { branches: [], invalid: [] });
  });

  it('marca lo que no es un nombre de rama', () => {
    assert.deepEqual(parseBranchList('qa -rf ~/x').invalid, ['-rf', '~/x']);
  });
});

describe('buildConfig', () => {
  it('saca las ramas de release de mergeBases y las protegidas por omisión de protectedBranches', () => {
    const { config, ignored } = buildConfig({ protectedBranches: ['main', 'qa'], mergeBases: ['staging', 'main'] });
    assert.deepEqual(ignored, ['main']);
    assert.deepEqual(config.mergeBases, ['staging']);
    assert.deepEqual(config.protectedBranches, ['qa']);
  });
});

describe('describeConfig', () => {
  it('explica qué se protege, hacia dónde mergea y desde cuándo aplica', () => {
    const text = describeConfig({ protectedBranches: ['qa'], mergeBases: ['staging'] });
    assert.match(text, /main, master, staging, production, qa/);
    assert.match(text, /mergea sin preguntarte a: staging/);
    assert.match(text, /origin\/main/);
  });

  it('sin mergeBases dice que todo merge pregunta', () => {
    assert.match(describeConfig({ protectedBranches: [], mergeBases: [] }), /te pregunta antes de cada merge/);
  });
});

describe('renderReport', () => {
  const groups = [
    {
      title: 'Máquina',
      checks: [
        { id: 'a', status: 'ok', title: 'Bien' },
        { id: 'b', status: 'fail', title: 'Mal', detail: 'porque sí', fix: 'arréglalo' },
        { id: 'c', status: 'warn', title: 'Ojo', detail: 'oculto sin --explain', fix: 'míralo' },
      ],
    },
  ];

  it('muestra símbolos, el paso a seguir y el resumen', () => {
    const text = renderReport(groups);
    assert.match(text, /✓ Bien/);
    assert.match(text, /✗ Mal\n {6}porque sí\n {6}→ arréglalo/);
    assert.match(text, /⚠ Ojo\n {6}→ míralo/);
    assert.doesNotMatch(text, /oculto sin --explain/);
    assert.match(text, /1 problema, 1 aviso\. Más detalle: claude-guard doctor --explain/);
  });

  it('con --explain muestra el detalle de los avisos', () => {
    assert.match(renderReport(groups, { explain: true }), /oculto sin --explain/);
  });

  it('dice "Todo en orden." sin problemas', () => {
    assert.match(renderReport([{ title: 'X', checks: [{ id: 'a', status: 'ok', title: 'Bien' }] }]), /Todo en orden\.$/);
  });
});
