export const ADVICE_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string' },
    suggestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          verdict: { type: 'string', enum: ['safe', 'review', 'keep'] },
          reason: { type: 'string' },
        },
        required: ['path', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['answer', 'suggestions'],
  additionalProperties: false,
} as const;
