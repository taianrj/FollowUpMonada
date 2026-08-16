import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@/types';
import { resolveClientForSuggestedTask } from './resolve-client';

const generalClient: Client = {
  id: '4b300e4d-62ee-4667-af5f-f620206db474',
  name: 'Geral / Sem Cliente Específico',
  created_at: '2026-08-16T12:00:00.000Z',
};

describe('resolveClientForSuggestedTask', () => {
  it('reutiliza cliente conhecido quando o resumo omite o client_id', async () => {
    const findByExactName = vi.fn();
    const create = vi.fn();

    const result = await resolveClientForSuggestedTask({
      clientId: null,
      clientName: '  geral / sem cliente específico  ',
      knownClients: [generalClient],
      findByExactName,
      create,
    });

    expect(result).toEqual({
      client: generalClient,
      clientId: generalClient.id,
      created: false,
    });
    expect(findByExactName).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('consulta novamente e reutiliza o cliente criado por uma requisição concorrente', async () => {
    const findByExactName = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: null })
      .mockResolvedValueOnce({ data: generalClient, error: null });
    const create = vi.fn().mockResolvedValue({
      data: null,
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });

    const result = await resolveClientForSuggestedTask({
      clientId: null,
      clientName: generalClient.name,
      knownClients: [],
      findByExactName,
      create,
    });

    expect(result.clientId).toBe(generalClient.id);
    expect(result.created).toBe(false);
    expect(findByExactName).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledOnce();
  });
});
