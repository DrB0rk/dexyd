import { DexydModule, ModuleContext, ModuleName } from '../core/module.js';

export function createScaffoldModule(
  name: ModuleName,
  capability: string,
  extra?: {
    onRegister?: (ctx: ModuleContext) => Promise<void> | void;
    onStart?: (ctx: ModuleContext) => Promise<void> | void;
    onStop?: (ctx: ModuleContext) => Promise<void> | void;
    healthDetails?: (ctx: ModuleContext) => Record<string, unknown>;
  }
): DexydModule {
  return {
    name,
    register: async (ctx) => {
      await extra?.onRegister?.(ctx);
    },
    start: async (ctx) => {
      await extra?.onStart?.(ctx);
    },
    stop: async (ctx) => {
      await extra?.onStop?.(ctx);
    },
    health: (ctx) => ({
      status: 'ready',
      checkedAt: new Date().toISOString(),
      details: {
        capability,
        ...(extra?.healthDetails?.(ctx) ?? {})
      }
    })
  };
}
