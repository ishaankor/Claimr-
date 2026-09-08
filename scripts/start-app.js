import { spawn } from 'child_process';
import electron from 'electron';

const child = spawn(electron, ['.'], {
  stdio: ['inherit', 'pipe', 'pipe'],
  env: { ...process.env, ELECTRON_ENABLE_LOGGING: 'false' },
});

child.stdout.pipe(process.stdout);

child.stderr.on('data', (data) => {
  const lines = data.toString().split('\n');
  const filtered = lines.filter((line) => {
    if (!line.trim()) return false;
    if (line.includes('ERROR:net/socket/ssl_client_socket_impl.cc')) return false;
    if (line.includes('Electron Security Warning')) return false;
    if (line.includes('btm_database.cc')) return false;
    if (line.includes('(electron) \'console-message\'')) return false;
    return true;
  });

  if (filtered.length > 0) {
    process.stderr.write(filtered.join('\n') + '\n');
  }
});

child.on('close', (code) => {
  process.exit(code || 0);
});
