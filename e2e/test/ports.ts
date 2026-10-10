/** Fixed local ports, away from the dev ports (8787, 8788) so a running dev stack does not clash. */
export const RELAY_PORT = 8797;
export const DASHBOARD_PORT = 8798;
export const RELAY_URL = `http://localhost:${RELAY_PORT}`;
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
