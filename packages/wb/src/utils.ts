import { killPortProcess } from 'kill-port-process';

export async function killPortProcessImmediatelyAndOnExit(port = 8080): Promise<void> {
  await killPortProcess(port);
  process.on('exit', async () => {
    await killPortProcess(port);
  });
}
