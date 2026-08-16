import { describe, expect, it } from 'vitest';
import {
  buildParseTasksSchema,
  buildWhatsappSummarySchema,
  parseTasksOutput,
  parseWhatsappSummaryOutput,
} from './schemas';

const statuses = ['aguardando cliente', 'resolvido'];

const validTask = {
  client_name: 'Acme',
  description: 'Corrigir relatório de faturamento',
  responsibles: ['Ana'],
  status: 'aguardando cliente',
  observations: '',
};

describe('structured outputs de IA', () => {
  it('valida uma resposta de tarefas completa', () => {
    expect(parseTasksOutput({ tasks: [validTask] }, statuses)).toEqual({ tasks: [validTask] });
  });

  it('aceita tasks vazio', () => {
    expect(parseTasksOutput({ tasks: [] }, statuses)).toEqual({ tasks: [] });
  });

  it('rejeita campos obrigatórios ausentes', () => {
    const incompleteTask = {
      client_name: validTask.client_name,
      responsibles: validTask.responsibles,
      status: validTask.status,
      observations: validTask.observations,
    };
    expect(() => parseTasksOutput({ tasks: [incompleteTask] }, statuses))
      .toThrow(/description/);
  });

  it('rejeita status fora dos IDs dinâmicos do banco', () => {
    expect(() => parseTasksOutput({
      tasks: [{ ...validTask, status: 'inventado' }],
    }, statuses)).toThrow(/status inválido/);
  });

  it('mantém cliente não encontrado para a criação controlada no backend', () => {
    const unknownClient = { ...validTask, client_name: 'Cliente Novo' };
    expect(parseTasksOutput({ tasks: [unknownClient] }, statuses).tasks[0].client_name)
      .toBe('Cliente Novo');
  });

  it('aceita responsáveis vazios', () => {
    const withoutResponsibles = { ...validTask, responsibles: [] };
    expect(parseTasksOutput({ tasks: [withoutResponsibles] }, statuses).tasks[0].responsibles)
      .toEqual([]);
  });

  it('constrói enum de status dinamicamente nos dois schemas', () => {
    expect(JSON.stringify(buildParseTasksSchema(statuses))).toContain('aguardando cliente');
    expect(JSON.stringify(buildWhatsappSummarySchema(statuses))).toContain('resolvido');
  });

  it('aceita null real e rejeita a string null no client_id do resumo', () => {
    const summary = {
      client_name: 'Cliente Novo',
      client_id: null,
      general_summary: 'Resumo executivo.',
      key_points: [],
      suggested_tasks: [{
        description: 'Enviar material',
        responsibles: [],
        status: 'resolvido',
        observations: '',
      }],
    };

    expect(parseWhatsappSummaryOutput({ summaries: [summary] }, statuses).summaries[0].client_id)
      .toBeNull();
    expect(() => parseWhatsappSummaryOutput({
      summaries: [{ ...summary, client_id: 'null' }],
    }, statuses)).toThrow(/UUID ou null/);
  });
});
