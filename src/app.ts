import fastify from 'fastify';
import { loadConfig } from './config/load-config.js';
import { ModuleManager } from './core/module-manager.js';
import { createCoreModules } from './modules/registry.js';
import { registerRoutes } from './http/register-routes.js';
import { AppContext, buildAppContext } from './runtime/app-context.js';
import { diagnoseFirewall } from './runtime/firewall-diagnostics.js';

type FastifyApp = ReturnType<typeof fastify>;

export type DexydApplication = {
  app: FastifyApp;
  context: AppContext;
  moduleManager: ModuleManager;
  start: () => Promise<void>;
  stop: () => Promise<void>;
};

export async function createDexydApplication(): Promise<DexydApplication> {
  const config = loadConfig();
  const context = buildAppContext(config);
  const moduleManager = new ModuleManager(createCoreModules());

  const app = fastify({
    loggerInstance: context.logger,
    trustProxy: true,
    disableRequestLogging: false
  });

  await moduleManager.registerAll(context);
  await registerRoutes(app, context, moduleManager);

  async function start(): Promise<void> {
    await moduleManager.startAll(context);
    await app.listen({
      host: config.server.host,
      port: config.server.port
    });

    context.logger.info(
      {
        host: config.server.host,
        port: config.server.port,
        modules: moduleManager.getModuleNames()
      },
      'dexyd bridge started'
    );

    diagnoseFirewall({ host: config.server.host, port: config.server.port, logger: context.logger }).catch((error) => {
      context.logger.warn({ error }, 'firewall diagnostic failed');
    });
  }

  async function stop(): Promise<void> {
    await moduleManager.stopAll(context);
    await app.close();
    context.db.close();
    context.logger.info('dexyd bridge stopped');
  }

  return {
    app,
    context,
    moduleManager,
    start,
    stop
  };
}
