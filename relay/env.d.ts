declare namespace Cloudflare {
  interface Env {
    REGISTRY: DurableObjectNamespace<import('./src/registry-do.ts').RegistryDO>;
    SESSION: DurableObjectNamespace<import('./src/session-do.ts').SessionDO>;
    /** Static dashboard assets, bound on the dashboard Worker only. */
    ASSETS?: Fetcher;
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_AUD?: string;
    ALLOWED_EMAILS?: string;
    /** Local development only. Honoured on loopback hosts and never set in a tracked config. */
    ALLOW_DEV_AUTH?: string;
  }
}
