// Reads calendars (Google / Outlook / Apple all publish an .ics link) and builds a "what's coming up" list.
const ical = require('node-ical');
const { extractActionItems } = require('./actions');

async function loadSource(src) {
  if (src.url) return ical.async.fromURL(src.url.replace(/^webcal:/i, 'https:'));
  if (src.path) return ical.async.parseFile(src.path);
  if (src.text) return ical.sync.parseICS(src.text);
  return {};
}

function occurrences(ev, from, to) {
  const durMs = (ev.end ? +ev.end : +ev.start + 3600_000) - +ev.start;
  if (!ev.rrule) return (+ev.start <= +to && +ev.start + durMs >= +from) ? [{ start: new Date(ev.start), end: new Date(+ev.start + durMs) }] : [];
  const out = [];
  const exdates = new Set(Object.values(ev.exdate || {}).map((d) => new Date(d).toISOString().slice(0, 10)));
  for (const d of ev.rrule.between(new Date(+from - durMs), to, true)) {
    const day = d.toISOString().slice(0, 10);
    if (exdates.has(day)) continue;
    const override = ev.recurrences && (ev.recurrences[day] || Object.values(ev.recurrences).find((r) => r.recurrenceid && new Date(r.recurrenceid).toISOString().slice(0, 10) === day));
    if (override) out.push({ start: new Date(override.start), end: new Date(override.end || +override.start + durMs), override });
    else out.push({ start: d, end: new Date(+d + durMs) });
  }
  return out;
}

/** Upcoming meetings across all calendar sources, sorted by start time. */
async function upcomingMeetings(sources, { days = 7, now = new Date() } = {}) {
  const from = new Date(now.getTime() - 60 * 60 * 1000);
  const to = new Date(now.getTime() + days * 86400_000);
  const meetings = [];
  const errors = [];
  for (const src of sources) {
    let data;
    try { data = await loadSource(src); } catch (e) { errors.push({ source: src.name || src.url || src.path, error: e.message }); continue; }
    for (const ev of Object.values(data)) {
      if (!ev || ev.type !== 'VEVENT' || !ev.start) continue;
      if (String(ev.status || '').toUpperCase() === 'CANCELLED') continue;
      for (const occ of occurrences(ev, from, to)) {
        const e = occ.override || ev;
        const description = typeof e.description === 'string' ? e.description : (e.description?.val || '');
        meetings.push({
          id: `${ev.uid || e.summary}-${occ.start.toISOString()}`,
          title: (typeof e.summary === 'string' ? e.summary : e.summary?.val) || '(no title)',
          start: occ.start.toISOString(),
          end: occ.end.toISOString(),
          location: typeof e.location === 'string' ? e.location : (e.location?.val || ''),
          description: description.slice(0, 4000),
          calendar: src.name || 'Calendar',
          allDay: e.datetype === 'date',
          link: (description.match(/https:\/\/[^\s"<>]*(?:zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex\.com)[^\s"<>]*/i) || [])[0] || null,
          actionItems: extractActionItems(description, { source: 'meeting' }),
        });
      }
    }
  }
  meetings.sort((a, b) => a.start.localeCompare(b.start));
  return { meetings, errors };
}

/** Which known companies does a meeting mention? Used to pull up related files before the meeting. */
function companiesInMeeting(meeting, companies) {
  const hay = `${meeting.title} ${meeting.description} ${meeting.location}`.toLowerCase();
  return companies.filter((c) => [c.name, ...(c.aliases || [])].some((n) => n && hay.includes(n.toLowerCase())));
}

module.exports = { upcomingMeetings, companiesInMeeting };
