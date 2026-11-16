// Small helper every page uses to call the API.
// It adds the login token (once login exists) and turns errors into
// readable messages. Pages must display data with textContent, never
// innerHTML, so text from the database can't run as script (XSS).

const TOKEN_KEY = 'onboarding_token';

function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function apiRequest(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${window.APP_CONFIG.API_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // Empty or non-JSON response
  }

  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

window.api = {
  get: (path) => apiRequest('GET', path),
  post: (path, body) => apiRequest('POST', path, body),
  put: (path, body) => apiRequest('PUT', path, body),
  patch: (path, body) => apiRequest('PATCH', path, body),
  TOKEN_KEY,
};
