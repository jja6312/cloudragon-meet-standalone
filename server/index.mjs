import { readConfig } from "./config.mjs";
import { createApp } from "./app.mjs";
process.umask(0o077);
try {
  const config = readConfig();
  const app = createApp(config);
  app.server.listen(config.port, config.host, () =>
    console.log(`Meet listening at ${config.baseUrl}`),
  );
  let stopping = false;
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, async () => {
      if (stopping) return;
      stopping = true;
      await app.close();
      process.exit(0);
    });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
