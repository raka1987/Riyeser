// Optional smarter sorting using Claude. Only used when the user adds an API key in Settings,
// and only for files the built-in rules are unsure about. Sends the first ~4,000 characters of the document.
const { DOC_TYPES } = require('./classifier');

const SCHEMA = {
  type: 'object',
  properties: {
    docType: { type: 'string', enum: [...DOC_TYPES.map((d) => d.type), 'Other'] },
    company: { type: ['string', 'null'], description: 'The outside business this document is for or from. Use the owner\'s own business name only when no outside business is involved. null if none.' },
    companyType: { type: 'string', description: 'e.g. Clients, Suppliers, Government, Banks, Utilities, Personal, or "My business" for the owner\'s own business' },
    confident: { type: 'boolean' },
    reason: { type: 'string', description: 'One short sentence a person can read: what the document is and who it is from/for.' },
    title: { type: 'string', description: 'A short title for the file name, 2-6 words, without the date, company or document type (e.g. "Elm project FHF comments", "Jo Bloggs week 45"). Empty if nothing useful to add.' },
    date: { type: ['string', 'null'], description: 'The document\'s own date as YYYY-MM-DD, or YYYY-MM if only the month is known; null if there is none.' },
  },
  required: ['docType', 'company', 'companyType', 'confident', 'reason', 'title', 'date'],
  additionalProperties: false,
};

// M26: which Claude model reads the files, charged to the customer's own key. Sorting is a short classification, so the
// default is the smallest, cheapest model; people can choose a bigger one in Settings -> AI.
const MODELS = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5: fastest and cheapest (recommended for sorting)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5: more careful, costs more' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5: most careful, costs the most' },
];
const DEFAULT_MODEL = 'claude-haiku-5-5';
const pickModel = (m) => (MODELS.some((x) => x.id === m) ? m : DEFAULT_MODEL);
// Models that can hand a declined request to another model on Riyeser's side (Haiku has no server-side fallback)
const FALLBACK = new Set(['claude-sonnet-5-5', 'claude-opus-5-5']);

/** The request for one file (exported for the tests). */
function request(model, system, content) {
  const base = { model: pickModel(model), max_tokens: 1024, output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } }, system, messages: [{ role: 'user', content }] };
  return FALLBACK.has(base.model) ? { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : base;
}

function createAI(apiKey, model = DEFAULT_MODEL, { client: given = null } = {}) {
  if (!apiKey && !given) return null;
  // loaded only when an AI key is in use (M8: a quicker first start)
  const client = given || new (require('@anthropic-ai/sdk'))({ apiKey });
  return {
    async classify(fileName, text, settings) {
      const known = (settings.companies || []).map((c) => `${c.name} (${c.type || 'Companies'})`).join(', ') || 'none yet';
      const own = (settings.ownCompanyNames || []).join(', ') || 'unknown';
      const params = request(model, 'You file documents for a small business owner, like a careful personal assistant. Read the document and decide what kind of document it is (use the closest type from the list) and which outside company it relates to. If it is about the owner\'s own business only (their payroll, their tax, their staff), use the owner\'s business name as the company and "My business" as the company type. Prefer the exact spelling of a company from the known list when it matches. Timesheets, payslips and payroll reports are different types - pick the precise one. Technical drawings (architectural, structural, mechanical/electrical/hydraulic/fire services layouts, schematics - usually with a title block showing drawing number, revision, scale, drawn/checked) are "Plans & Drawings" even when their notes mention quotes, tenders or estimates. Only use Quotes, Invoices or Receipts when the document itself prices goods or work.',
        `The user's own business names: ${own}\nKnown companies: ${known}\n\nFile name: ${fileName}\n\nDocument text (start):\n${text.slice(0, 4000)}`);
      const response = params.betas ? await client.beta.messages.create(params) : await client.messages.create(params);
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
        aiTitle: (r.title || '').replace(/[<>:"/\\|?*]/g, '').trim().slice(0, 60) || null,
        aiDate: /^\d{4}-\d{2}(-\d{2})?$/.test(r.date || '') ? r.date : null,
      };
    },
  };
}

module.exports = { createAI, request, MODELS, DEFAULT_MODEL, pickModel };
