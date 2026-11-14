// Optional smarter sorting using Claude. Only used when the user adds an API key in Settings,
// and only for files the built-in rules are unsure about. Sends the first ~4,000 characters of the document.
const Anthropic = require('@anthropic-ai/sdk');
const { DOC_TYPES } = require('./classifier');

const SCHEMA = {
  type: 'object',
  properties: {
    docType: { type: 'string', enum: [...DOC_TYPES.map((d) => d.type), 'Other'] },
    company: { type: ['string', 'null'], description: 'The other business this document is for or from, never the user\'s own company. null if none.' },
    companyType: { type: 'string', description: 'e.g. Clients, Suppliers, Government, Banks, Utilities, Personal' },
    confident: { type: 'boolean' },
  },
  required: ['docType', 'company', 'companyType', 'confident'],
  additionalProperties: false,
};

function createAI(apiKey, model = 'claude-opus-5-5') {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });
  return {
    async classify(fileName, text, settings) {
      const known = (settings.companies || []).map((c) => `${c.name} (${c.type || 'Companies'})`).join(', ') || 'none yet';
      const own = (settings.ownCompanyNames || []).join(', ') || 'unknown';
      const response = await client.beta.messages.create({
        model,
        max_tokens: 1024,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
        system: 'You file documents for a small business owner. Decide what kind of document this is and which outside company it relates to. Prefer the exact spelling of a company from the known list when it matches.',
        messages: [{
          role: 'user',
          content: `The user's own business names: ${own}\nKnown companies: ${known}\n\nFile name: ${fileName}\n\nDocument text (start):\n${text.slice(0, 4000)}`,
        }],
      });
      if (response.stop_reason === 'refusal') return null;
      const block = response.content.find((b) => b.type === 'text');
      if (!block) return null;
      const r = JSON.parse(block.text);
      const match = (settings.companies || []).find((c) => r.company && c.name.toLowerCase() === r.company.toLowerCase());
      return {
        docType: r.docType,
        company: r.company,
        companyType: match ? (match.type || 'Companies') : (r.companyType || 'Companies'),
        category: r.company ? 'Company' : 'General',
        confidence: r.confident ? 'high' : 'medium',
      };
    },
  };
}

module.exports = { createAI };
