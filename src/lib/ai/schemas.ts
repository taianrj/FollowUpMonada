export type JsonSchema = Record<string, unknown>;

export interface ParsedTask {
  client_name: string;
  description: string;
  responsibles: string[];
  status: string;
  observations: string;
}

export interface ParseTasksOutput {
  tasks: ParsedTask[];
}

export interface SuggestedTask {
  description: string;
  responsibles: string[];
  status: string;
  observations: string;
}

export interface WhatsappClientSummary {
  client_name: string;
  client_id: string | null;
  general_summary: string;
  key_points: string[];
  suggested_tasks: SuggestedTask[];
}

export interface WhatsappSummaryOutput {
  summaries: WhatsappClientSummary[];
}

export class StructuredOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StructuredOutputError';
  }
}

const stringArraySchema: JsonSchema = {
  type: 'array',
  items: { type: 'string' },
};

function statusSchema(validStatusIds: readonly string[]): JsonSchema {
  return {
    type: 'string',
    enum: [...validStatusIds],
  };
}

function suggestedTaskSchema(validStatusIds: readonly string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      description: { type: 'string' },
      responsibles: stringArraySchema,
      status: statusSchema(validStatusIds),
      observations: { type: 'string' },
    },
    required: ['description', 'responsibles', 'status', 'observations'],
  };
}

export function buildParseTasksSchema(validStatusIds: readonly string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            client_name: { type: 'string' },
            description: { type: 'string' },
            responsibles: stringArraySchema,
            status: statusSchema(validStatusIds),
            observations: { type: 'string' },
          },
          required: ['client_name', 'description', 'responsibles', 'status', 'observations'],
        },
      },
    },
    required: ['tasks'],
  };
}

export function buildWhatsappSummarySchema(validStatusIds: readonly string[]): JsonSchema {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      summaries: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            client_name: { type: 'string' },
            client_id: {
              anyOf: [
                { type: 'string', format: 'uuid' },
                { type: 'null' },
              ],
            },
            general_summary: { type: 'string' },
            key_points: stringArraySchema,
            suggested_tasks: {
              type: 'array',
              items: suggestedTaskSchema(validStatusIds),
            },
          },
          required: ['client_name', 'client_id', 'general_summary', 'key_points', 'suggested_tasks'],
        },
      },
    },
    required: ['summaries'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new StructuredOutputError(`${path} deve ser um objeto.`);
  }
  return value;
}

function requireString(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new StructuredOutputError(`${path} deve ser uma string${allowEmpty ? '' : ' não vazia'}.`);
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new StructuredOutputError(`${path} deve ser uma lista de strings.`);
  }
  return value;
}

function requireStatus(value: unknown, path: string, validStatusIds: readonly string[]): string {
  const status = requireString(value, path);
  if (!validStatusIds.includes(status)) {
    throw new StructuredOutputError(`${path} contém um status inválido.`);
  }
  return status;
}

function parseSuggestedTask(
  value: unknown,
  path: string,
  validStatusIds: readonly string[],
): SuggestedTask {
  const item = requireRecord(value, path);
  return {
    description: requireString(item.description, `${path}.description`),
    responsibles: requireStringArray(item.responsibles, `${path}.responsibles`),
    status: requireStatus(item.status, `${path}.status`, validStatusIds),
    observations: requireString(item.observations, `${path}.observations`, true),
  };
}

export function parseTasksOutput(value: unknown, validStatusIds: readonly string[]): ParseTasksOutput {
  const root = requireRecord(value, 'resposta');
  if (!Array.isArray(root.tasks)) {
    throw new StructuredOutputError('resposta.tasks deve ser uma lista.');
  }

  return {
    tasks: root.tasks.map((value, index) => {
      const path = `resposta.tasks[${index}]`;
      const item = requireRecord(value, path);
      return {
        client_name: requireString(item.client_name, `${path}.client_name`),
        description: requireString(item.description, `${path}.description`),
        responsibles: requireStringArray(item.responsibles, `${path}.responsibles`),
        status: requireStatus(item.status, `${path}.status`, validStatusIds),
        observations: requireString(item.observations, `${path}.observations`, true),
      };
    }),
  };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseWhatsappSummaryOutput(
  value: unknown,
  validStatusIds: readonly string[],
): WhatsappSummaryOutput {
  const root = requireRecord(value, 'resposta');
  if (!Array.isArray(root.summaries)) {
    throw new StructuredOutputError('resposta.summaries deve ser uma lista.');
  }

  return {
    summaries: root.summaries.map((value, index) => {
      const path = `resposta.summaries[${index}]`;
      const item = requireRecord(value, path);
      const clientId = item.client_id;
      if (clientId !== null && (typeof clientId !== 'string' || !UUID_PATTERN.test(clientId))) {
        throw new StructuredOutputError(`${path}.client_id deve ser UUID ou null.`);
      }
      if (!Array.isArray(item.suggested_tasks)) {
        throw new StructuredOutputError(`${path}.suggested_tasks deve ser uma lista.`);
      }

      return {
        client_name: requireString(item.client_name, `${path}.client_name`),
        client_id: clientId,
        general_summary: requireString(item.general_summary, `${path}.general_summary`),
        key_points: requireStringArray(item.key_points, `${path}.key_points`),
        suggested_tasks: item.suggested_tasks.map((task, taskIndex) => (
          parseSuggestedTask(task, `${path}.suggested_tasks[${taskIndex}]`, validStatusIds)
        )),
      };
    }),
  };
}

export function parseJsonResponse(text: string): unknown {
  if (!text.trim()) {
    throw new StructuredOutputError('O provedor retornou uma resposta vazia.');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new StructuredOutputError('O provedor retornou JSON inválido.');
  }
}
