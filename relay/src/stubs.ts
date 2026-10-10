import type { RegistryDO } from './registry-do.ts';
import type { SessionDO } from './session-do.ts';

export function registryStub(env: Cloudflare.Env): DurableObjectStub<RegistryDO> {
  return env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
}

export function sessionStub(env: Cloudflare.Env, installId: string): DurableObjectStub<SessionDO> {
  return env.SESSION.get(env.SESSION.idFromName(installId));
}
