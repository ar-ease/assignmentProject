import { execFileSync } from 'node:child_process';

export default function setup() {
  execFileSync('npm', ['run', 'db:migrate'], { stdio: 'inherit', env: process.env });
}
