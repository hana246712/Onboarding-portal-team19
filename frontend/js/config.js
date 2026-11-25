// Address of the API. No secrets ever go in frontend files.
window.APP_CONFIG = {
  API_URL:
    location.hostname === 'localhost' || location.hostname === '127.0.0.1'
      ? 'http://localhost:3000'
      : 'https://team19-api.vercel.app',
};
