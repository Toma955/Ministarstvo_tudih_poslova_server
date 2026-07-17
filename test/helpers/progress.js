// Vidljiv status tijekom server testova.
// Terminal: npm test
// ili: tail -f /tmp/mk-server-test-progress.log

import fs from "fs";

const LOG_PATH = "/tmp/mk-server-test-progress.log";
let step = 0;

function stamp() {
  return new Date().toISOString();
}

function write(line) {
  const text = `${line}\n`;
  process.stdout.write(text);
  fs.appendFileSync(LOG_PATH, text);
}

export function progressReset(suite) {
  step = 0;
  const header = `========================================
SUITE ${suite}
started ${stamp()}
log file: ${LOG_PATH}
========================================
`;
  fs.writeFileSync(LOG_PATH, header);
  process.stdout.write(header);
}

export function progressStep(message) {
  step += 1;
  write(`[${stamp()}] ▶ ${step}. ${message}`);
}

export function progressOk(message) {
  write(`[${stamp()}] ✔ ${message}`);
}

export function progressFail(message) {
  write(`[${stamp()}] ✖ ${message}`);
}

export function progressDone(suite) {
  write(`----------------------------------------
SUITE ${suite} DONE ${stamp()}
----------------------------------------`);
}
