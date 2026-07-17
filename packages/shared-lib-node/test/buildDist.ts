import { execFileSync } from 'node:child_process';

export default function buildDist(): void {
  execFileSync('bun', ['run', 'build'], { stdio: 'inherit' });
}
