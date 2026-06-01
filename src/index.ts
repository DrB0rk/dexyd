import { createDexydApplication } from './app.js';

const main = async (): Promise<void> => {
  const service = await createDexydApplication();
  await service.start();

  const shutdown = async (signal: string): Promise<void> => {
    service.context.logger.info({ signal }, 'shutdown signal received');
    await service.stop();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
};

main().catch((error) => {
  console.error('Fatal startup error', error);
  process.exit(1);
});
