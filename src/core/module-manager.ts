import { DexydModule, ModuleContext, ModuleHealth, ModuleName } from './module.js';

export class ModuleManager {
  readonly #modulesByName = new Map<ModuleName, DexydModule>();
  readonly #orderedModules: DexydModule[] = [];

  constructor(modules: DexydModule[]) {
    for (const module of modules) {
      if (this.#modulesByName.has(module.name)) {
        throw new Error(`Duplicate module: ${module.name}`);
      }
      this.#modulesByName.set(module.name, module);
      this.#orderedModules.push(module);
    }
  }

  getModuleNames(): ModuleName[] {
    return this.#orderedModules.map((module) => module.name);
  }

  async registerAll(ctx: ModuleContext): Promise<void> {
    for (const module of this.#orderedModules) {
      await module.register?.(ctx);
      ctx.logger.info({ module: module.name }, 'module registered');
    }
  }

  async startAll(ctx: ModuleContext): Promise<void> {
    for (const module of this.#orderedModules) {
      await module.start?.(ctx);
      ctx.logger.info({ module: module.name }, 'module started');
    }
  }

  async stopAll(ctx: ModuleContext): Promise<void> {
    for (const module of [...this.#orderedModules].reverse()) {
      await module.stop?.(ctx);
      ctx.logger.info({ module: module.name }, 'module stopped');
    }
  }

  async health(ctx: ModuleContext): Promise<Record<ModuleName, ModuleHealth>> {
    const entries = await Promise.all(
      this.#orderedModules.map(async (module) => {
        const result = await module.health(ctx);
        return [module.name, result] as const;
      })
    );

    return Object.fromEntries(entries) as Record<ModuleName, ModuleHealth>;
  }
}
