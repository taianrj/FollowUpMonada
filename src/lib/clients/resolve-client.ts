import type { Client } from '@/types';

interface ClientOperationError {
  code?: string;
  message: string;
}

interface ClientOperationResult {
  data: Client | null;
  error: ClientOperationError | null;
}

interface ResolveClientOptions {
  clientId: string | null;
  clientName: string;
  knownClients: Client[];
  findByExactName: (name: string) => Promise<ClientOperationResult>;
  create: (name: string) => Promise<ClientOperationResult>;
  onCreate?: (name: string) => void;
}

export interface ResolvedClient {
  client: Client | null;
  clientId: string;
  created: boolean;
}

const normalizeClientName = (name: string) => name.trim().toLocaleLowerCase('pt-BR');

export const findKnownClientByName = (clients: Client[], name: string): Client | null => {
  const normalizedName = normalizeClientName(name);
  return clients.find((client) => normalizeClientName(client.name) === normalizedName) ?? null;
};

export async function resolveClientForSuggestedTask({
  clientId,
  clientName,
  knownClients,
  findByExactName,
  create,
  onCreate,
}: ResolveClientOptions): Promise<ResolvedClient> {
  if (clientId) {
    return { client: null, clientId, created: false };
  }

  const requestedName = clientName.trim();
  const knownClient = findKnownClientByName(knownClients, requestedName);
  if (knownClient) {
    return { client: knownClient, clientId: knownClient.id, created: false };
  }

  const lookupResult = await findByExactName(requestedName);
  if (lookupResult.error) {
    throw new Error(`Falha ao buscar o cliente: ${lookupResult.error.message}`);
  }
  if (lookupResult.data) {
    return { client: lookupResult.data, clientId: lookupResult.data.id, created: false };
  }

  onCreate?.(requestedName);
  const createResult = await create(requestedName);
  if (!createResult.error && createResult.data) {
    return { client: createResult.data, clientId: createResult.data.id, created: true };
  }

  // Outra requisição pode ter criado o mesmo cliente entre a consulta e o insert.
  if (createResult.error?.code === '23505') {
    const concurrentLookup = await findByExactName(requestedName);
    if (!concurrentLookup.error && concurrentLookup.data) {
      return {
        client: concurrentLookup.data,
        clientId: concurrentLookup.data.id,
        created: false,
      };
    }
  }

  throw new Error(
    `Falha ao cadastrar o cliente automaticamente: ${createResult.error?.message ?? 'resposta inválida do banco de dados.'}`,
  );
}
