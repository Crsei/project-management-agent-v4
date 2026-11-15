import { agentLogin, agentLogout, agentStatus } from './agent-connection.ts';
import { nonempty, parseOptions, type CliFamily } from './runtime.ts';

export const agentAccessFamily: CliFamily = {
  help: `Agent service connection (PM permissions remain independent):
  pm agent login [--origin URL] [--token-file ABSOLUTE_PRIVATE_FILE | --token-stdin true]
  pm agent status [--origin URL]
  pm agent logout [--origin URL]

Set PM_AGENT_URL explicitly for Agent commands; gateway URLs include /agent.
Unconfigured loopback services connect directly: no Agent login or token is needed.
Status reports local_unprotected; no cookie, credential file or expiry is invented.
Configured services still require login, using a hidden token or explicit private file/stdin.
PM_AGENT_SESSION_DIR selects a private absolute credential directory.
Saved Agent cookies expire locally after 8 hours. Logout removes this CLI identity,
not copied server cookies; actual server revocation requires deployment-token rotation.
`,
  async dispatch(args, runtime) {
    const action = args[1];
    if (args[0] !== 'agent' || !action || !['login', 'status', 'logout'].includes(action)) return false;
    const options = parseOptions(args.slice(2), action === 'login' ? ['origin', 'token-file', 'token-stdin'] : ['origin']);
    const connection = options.origin === undefined ? {} : { origin: nonempty(options.origin, '--origin') };
    if (action === 'login') {
      if (options['token-stdin'] !== undefined && options['token-stdin'] !== 'true') throw new Error('--token-stdin requires true');
      if (options['token-file'] !== undefined && options['token-stdin'] !== undefined) throw new Error('Choose either --token-file or --token-stdin');
      runtime.print(await agentLogin({
        ...connection,
        ...(options['token-file'] === undefined ? {} : { tokenFile: nonempty(options['token-file'], '--token-file') }),
        ...(options['token-stdin'] === undefined ? {} : { tokenStdin: true }),
      }));
    } else if (action === 'status') {
      runtime.print(await agentStatus(connection));
    } else {
      runtime.print(await agentLogout(connection));
    }
    return true;
  },
};
