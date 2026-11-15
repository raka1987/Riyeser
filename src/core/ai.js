// Optional smarter sorting using Claude. Only used when the user adds an API key in Settings,
// and only for files the built-in rules are unsure about. Sends the first ~4,000 characters of the document.
const Anthropic = require('@anthropic-ai/sdk');
const { DOC_TYPES } = require('./classifier');

const SCHEMA = {
  type: 'object',
  properties: {
    docType: { type: 'string', enum: [...DOC_TYPES.map((d) => d.type), 'Other'] },
    company: { type: ['string', 'null'], description: 'The outside business this document is for or from. Use the owner\'s own business name only when no outside business is involved. null if none.' },
    companyType: { type: 'string', description: 'e.g. Clients, Suppliers, Government, Banks, Utilities, Personal, or "My business" for the owner\'s own business' },
    confident: { type: 'boolean' },
    reason: { type: 'string', description: 'One short sentence a person can read: what the document is and who it is from/for.' },
  },
  required: ['docType', 'company', 'companyType', 'confident', 'reason'],
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
        system: 'You file documents for a small business owner, like a careful personal assistant. Read the document and decide what kind of document it is (use the closest type from the list) and which outside company it relates to. If it is about the owner\'s own business only (their payroll, their tax, their staff), use the owner\'s business name as the company and "My business" as the company type. Prefer the exact spelling of a company from the known list when it matches. Timesheets, payslips and payroll reports are different types - pick the precise one.',
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
        reasons: [`AI checked: ${r.reason}`],
      };
    },
  };
}

module.exports = { createAI };
