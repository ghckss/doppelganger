import { createApplication } from './app.js';

async function main() {
  const application = createApplication({
    cwd: process.cwd()
  });

  const [command, target] = process.argv.slice(2);

  if (command === 'poll' && target === 'slack-mentions') {
    const result = await application.taskService.pollSlackMentions();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'poll' && target === 'github-reviews') {
    const result = await application.taskService.pollGitHubReviews();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'serve') {
    application.server.listen(application.config.app.port, application.config.app.host, () => {
      console.log(`Agent server listening on ${application.config.app.baseUrl}`);
    });
    return;
  }

  console.log('Usage:');
  console.log('  node server/src/cli.js poll slack-mentions');
  console.log('  node server/src/cli.js poll github-reviews');
  console.log('  node server/src/cli.js serve');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
