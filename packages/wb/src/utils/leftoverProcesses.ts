import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const POLL_INTERVAL_MS = 1000;

interface ProcessInfo {
  pid: number;
  parentPid: number;
  /** Tells a tracked process from an unrelated one that reuses its PID. */
  startedAt: string;
  command: string;
}

/**
 * Tracks the descendants of `rootPid` by polling, because a process whose parent died is reparented
 * and can no longer be found from `rootPid`. Call the returned function once `rootPid` has exited: it
 * sends `SIGTERM` to the tracked processes still alive, with their descendants, and returns their descriptions.
 */
export function trackDescendants(rootPid: number): () => Promise<string[]> {
  // Ancestors precede their descendants.
  let tracked = new Map<number, ProcessInfo>();
  const poll = async (rootPids: number[]): Promise<void> => {
    const processes = await listProcesses();
    const startedAtByPid = new Map(processes.map((p) => [p.pid, p.startedAt]));
    const next = new Map([...tracked].filter(([pid, p]) => startedAtByPid.get(pid) === p.startedAt));
    const queue = [...rootPids, ...next.keys()];
    for (const pid of queue) {
      for (const child of processes) {
        if (child.parentPid !== pid || next.has(child.pid)) continue;

        next.set(child.pid, child);
        queue.push(child.pid);
      }
    }
    tracked = next;
  };

  let polling: Promise<void> | undefined;
  const timer = setInterval(() => {
    // A failed poll only delays tracking until the next one.
    polling ??= poll([rootPid])
      .catch(() => {})
      .finally(() => {
        polling = undefined;
      });
  }, POLL_INTERVAL_MS);

  return async () => {
    clearInterval(timer);
    await polling;
    try {
      // Without `rootPid`, which another process may reuse now that its process has exited.
      await poll([]);
    } catch {
      // The tracked PIDs cannot be told from reused ones.
      return [];
    }
    for (const pid of tracked.keys()) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // The process has exited since the poll.
      }
    }
    return [...tracked.values()].map((p) => `${p.pid} ${p.command}`);
  };
}

async function listProcesses(): Promise<ProcessInfo[]> {
  const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=,lstart=,command='], {
    // lstart is 24 characters wide only in the C locale.
    env: { ...process.env, LC_ALL: 'C' },
    maxBuffer: 64 * 1024 * 1024,
    // A `ps` that never returns must not keep wb from exiting.
    timeout: 10_000,
  });
  const processes: ProcessInfo[] = [];
  for (const line of stdout.split('\n')) {
    const matched = /^\s*(\d+)\s+(\d+)\s+(.{24})\s+(.*)$/.exec(line);
    if (!matched) continue;

    processes.push({
      pid: Number(matched[1]),
      parentPid: Number(matched[2]),
      startedAt: matched[3]!,
      command: matched[4]!,
    });
  }
  return processes;
}
