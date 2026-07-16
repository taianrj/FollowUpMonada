import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync(new URL('../../../.github/workflows/deploy.yml', import.meta.url), 'utf8');

describe('workflow de deploy', () => {
  it('instala as dependencias da aplicacao e do servico antes dos testes', () => {
    const rootInstall = workflow.indexOf('npm ci');
    const serviceInstall = workflow.indexOf('npm --prefix whatsapp-service ci');
    const tests = workflow.indexOf('npm test');

    expect(rootInstall).toBeGreaterThan(-1);
    expect(serviceInstall).toBeGreaterThan(rootInstall);
    expect(tests).toBeGreaterThan(serviceInstall);
  });
});
