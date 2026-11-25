// Calls the API with the login token and turns errors into readable messages.
// A 401 sends the user back to the login page.

async function apiRequest(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = window.auth ? window.auth.getToken() : null;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${window.APP_CONFIG.API_URL}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('Cannot reach the server. Check your connection and try again.');
    err.status = 0;
    throw err;
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON response
  }

  if (!res.ok) {
    // A logged-in request that comes back 401 means the session is over.
    // (The login request itself also returns 401 for a wrong password, so
    // it is left to the login page to show that message.)
    if (res.status === 401 && token && window.auth) {
      window.auth.goToLogin('expired');
    }
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.status = res.status;
    const retry = Number(res.headers.get('Retry-After'));
    if (Number.isFinite(retry) && retry > 0) err.retryAfter = retry; // seconds (429)
    throw err;
  }
  return data;
}

window.api = {
  get: (path) => apiRequest('GET', path),
  post: (path, body) => apiRequest('POST', path, body),
  put: (path, body) => apiRequest('PUT', path, body),
  patch: (path, body) => apiRequest('PATCH', path, body),
};
