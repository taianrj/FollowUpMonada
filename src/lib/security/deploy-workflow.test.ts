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

  it('usa apenas valores ficticios do Supabase no build de validacao', () => {
    expect(workflow).toContain('NEXT_PUBLIC_SUPABASE_URL: https://ci-placeholder.supabase.co');
    expect(workflow).toContain('NEXT_PUBLIC_SUPABASE_ANON_KEY: ci-placeholder');
    expect(workflow).not.toContain('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('baixa o commit privado sem persistir token na URL remota', () => {
    expect(workflow).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(workflow).toContain('DEPLOY_SHA: ${{ github.sha }}');
    expect(workflow).toContain('envs: GITHUB_TOKEN,DEPLOY_SHA');
    expect(workflow).toContain('Authorization: Bearer $GITHUB_TOKEN');
    expect(workflow).toContain('tarball/$DEPLOY_SHA');
    expect(workflow).not.toContain('git fetch');
    expect(workflow).not.toMatch(/https:\/\/[^/\s]+@github\.com/);
  });
});
