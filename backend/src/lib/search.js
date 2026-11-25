// Turns search text into an ILIKE pattern with % and _ escaped, so they match literally.

const MAX_SEARCH = 100;

// Returns { value: pattern | null } or { error } for a 400.
function searchPattern(raw) {
  if (raw === undefined) return { value: null };
  if (typeof raw !== 'string' || raw.length > MAX_SEARCH) {
    return { error: `search must be text of at most ${MAX_SEARCH} characters` };
  }
  const term = raw.trim();
  if (!term) return { value: null };
  return { value: `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%` };
}

module.exports = { searchPattern, MAX_SEARCH };
