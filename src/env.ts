const AUTH_CLIENT_ID = import.meta.env.VITE_BODHI_APP_CLIENT_ID;
const AUTH_SERVER_URL = import.meta.env.VITE_BODHI_AUTH_SERVER_URL;

if (!AUTH_CLIENT_ID) {
  throw new Error(
    'VITE_BODHI_APP_CLIENT_ID is required. Register your app on https://developer.getbodhi.app ' +
      'and set it in .env (copy from .env.example).'
  );
}
if (!AUTH_SERVER_URL) {
  throw new Error(
    'VITE_BODHI_AUTH_SERVER_URL is required (e.g. https://main-id.getbodhi.app/realms/bodhi).'
  );
}

export { AUTH_CLIENT_ID, AUTH_SERVER_URL };
