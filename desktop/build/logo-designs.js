// Logo designs as SVG (512x512). Each family has a Desk Assistant icon and a matching Desk PDF icon.
const bg = (id, a, b) => `<defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect x="16" y="16" width="480" height="480" rx="112" fill="url(#${id})"/>`;
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${body}</svg>`;
const sparkle = (cx, cy, r, fill) => `<path d="M${cx} ${cy - r} C${cx + r * 0.16} ${cy - r * 0.16} ${cx + r * 0.16} ${cy - r * 0.16} ${cx + r} ${cy} C${cx + r * 0.16} ${cy + r * 0.16} ${cx + r * 0.16} ${cy + r * 0.16} ${cx} ${cy + r} C${cx - r * 0.16} ${cy + r * 0.16} ${cx - r * 0.16} ${cy + r * 0.16} ${cx - r} ${cy} C${cx - r * 0.16} ${cy - r * 0.16} ${cx - r * 0.16} ${cy - r * 0.16} ${cx} ${cy - r}Z" fill="${fill}"/>`;
const page = (fill = '#fff') => `<path d="M168 104 H300 L364 168 V392 Q364 408 348 408 H168 Q152 408 152 392 V120 Q152 104 168 104Z" fill="${fill}"/><path d="M300 104 V152 Q300 168 316 168 H364Z" fill="rgba(0,0,0,.18)"/>`;

module.exports = {
  // A: smart folder with a sparkle
  'A-assistant': svg(`${bg('g', '#6366F1', '#2563EB')}
    <path d="M104 176 Q104 152 128 152 H208 L240 184 H384 Q408 184 408 208 V224 H104Z" fill="#fff" opacity=".55"/>
    <rect x="104" y="208" width="304" height="176" rx="28" fill="#fff"/>
    ${sparkle(256, 296, 58, '#4F46E5')}${sparkle(352, 132, 30, '#FDE68A')}`),
  'A-pdf': svg(`${bg('g', '#F43F5E', '#EA580C')}${page()}
    <rect x="190" y="200" width="120" height="18" rx="9" fill="#FDA4AF"/><rect x="190" y="236" width="140" height="18" rx="9" fill="#FDA4AF"/>
    ${sparkle(264, 322, 46, '#E11D48')}${sparkle(352, 132, 30, '#FDE68A')}`),

  // B: neatly sorted stack with a tick
  'B-assistant': svg(`${bg('g', '#0EA5E9', '#1D4ED8')}
    <rect x="120" y="132" width="250" height="72" rx="20" fill="#fff" opacity=".45"/>
    <rect x="120" y="220" width="250" height="72" rx="20" fill="#fff" opacity=".7"/>
    <rect x="120" y="308" width="250" height="72" rx="20" fill="#fff"/>
    <rect x="148" y="334" width="110" height="20" rx="10" fill="#93C5FD"/>
    <circle cx="364" cy="352" r="70" fill="#10B981" stroke="#fff" stroke-width="16"/>
    <path d="M330 352 L354 376 L398 330" fill="none" stroke="#fff" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/>`),
  'B-pdf': svg(`${bg('g', '#EF4444', '#B91C1C')}${page()}
    <rect x="190" y="196" width="130" height="18" rx="9" fill="#FCA5A5"/><rect x="190" y="232" width="150" height="18" rx="9" fill="#FCA5A5"/><rect x="190" y="268" width="100" height="18" rx="9" fill="#FCA5A5"/>
    <g transform="rotate(-45 352 356)"><rect x="296" y="330" width="120" height="52" rx="12" fill="#1F2937" stroke="#fff" stroke-width="12"/><path d="M296 336 L256 356 L296 376Z" fill="#FBBF24" stroke="#fff" stroke-width="10" stroke-linejoin="round"/></g>`),

  // C: dark, premium - amber folder with an arrow filing into it
  'C-assistant': svg(`${bg('g', '#1E293B', '#0B1120')}
    <path d="M96 196 Q96 172 120 172 H204 L236 204 H392 Q416 204 416 228 V372 Q416 396 392 396 H120 Q96 396 96 372Z" fill="#F59E0B"/>
    <path d="M96 252 Q96 236 112 236 H400 Q416 236 416 252 V372 Q416 396 392 396 H120 Q96 396 96 372Z" fill="#FBBF24"/>
    <path d="M256 92 V282" stroke="#fff" stroke-width="40" stroke-linecap="round"/>
    <path d="M190 220 L256 290 L322 220" fill="none" stroke="#fff" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"/>`),
  'C-pdf': svg(`${bg('g', '#1E293B', '#0B1120')}${page('#F8FAFC')}
    <rect x="186" y="300" width="148" height="70" rx="14" fill="#EF4444"/>
    <text x="260" y="350" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-weight="800" font-size="46" fill="#fff">PDF</text>
    <rect x="190" y="196" width="130" height="18" rx="9" fill="#CBD5E1"/><rect x="190" y="232" width="150" height="18" rx="9" fill="#CBD5E1"/>`),
};
