import { createApplication } from './app.js';

const { config, server } = createApplication({
  cwd: process.cwd()
});

server.listen(config.app.port, config.app.host, () => {
  console.log(`Agent server listening on ${config.app.baseUrl}`);
});
