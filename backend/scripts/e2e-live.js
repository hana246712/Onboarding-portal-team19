// End-to-end test on the LIVE site - Owner: Hana Anwar (issue #28).
//
//   cd backend
//   npm run e2e:live
//
// Runs docs/postman/e2e-live.postman_collection.json with Newman against the
// deployed API (https://team19-api.vercel.app): one full onboarding from
// template to completed plan, checked on the dashboard, notifications and
// audit log. It creates its own test Staff and Customer accounts (emails end
// in @example.test) and one template, and deactivates/archives them at the end.
//
// It asks for a live Admin login. The password is typed without being shown,
// passed to Newman through a temporary file only you can read, and deleted
// right after the run. It is never stored, logged or put on the command line.
// (In a pipeline: E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD may be set instead.)
//
// Writes the results table to docs/testing/e2e-live-results.md (evidence for
// the report) and exits 1 if any check failed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');

const LIVE_API = 'https://team19-api.vercel.app';
const root = path.join(__dirname, '..', '..');
const collection = path.join(root, 'docs', 'postman', 'e2e-live.postman_collection.json');
const resultsFile = path.join(root, 'docs', 'testing', 'e2e-live-results.md');

function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (text) => {
        if (text.includes(question)) rl.output.write(question); // show the question, not the typing
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log(`End-to-end test of the live site (${LIVE_API}).`);
  console.log('It creates test accounts and one template there, and cleans them up at the end.\n');
  const email = process.env.E2E_ADMIN_EMAIL || (await ask('Live Admin email: '));
  const password = process.env.E2E_ADMIN_PASSWORD || (await ask('Live Admin password (not shown): ', true));
  if (!email || !password) {
    console.error('An Admin email and password are needed.');
    return 1;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'team19-e2e-'));
  const envFile = path.join(dir, 'env.json');
  const reportFile = path.join(dir, 'report.json');
  try {
    fs.writeFileSync(envFile, JSON.stringify({
      name: 'live (temporary)',
      values: [
        { key: 'baseUrl', value: LIVE_API, enabled: true },
        { key: 'adminEmail', value: email, enabled: true },
        { key: 'adminPassword', value: password, type: 'secret', enabled: true },
      ],
    }), { mode: 0o600 });

    // Only file paths (ours, quoted) go on the command line, never the password.
    const command = `npx --yes newman@6 run "${collection}" -e "${envFile}" --reporters cli,json --reporter-json-export "${reportFile}"`;
    const run = spawnSync(command, { stdio: 'inherit', shell: true });

    if (!fs.existsSync(reportFile)) {
      console.error('Newman did not produce a report.');
      return run.status || 1;
    }
    const summary = spawnSync(process.execPath, [path.join(__dirname, 'newman-summary.js'), reportFile,
      `End-to-end test on the live site (issue #28), ${new Date().toISOString().slice(0, 10)}`], { encoding: 'utf8' });
    fs.mkdirSync(path.dirname(resultsFile), { recursive: true });
    // The report never contains the password: Newman only records request names and test results here.
    fs.writeFileSync(resultsFile, `${summary.stdout}\n`);
    console.log(`\nResults table written to ${path.relative(root, resultsFile)}`);
    return summary.status === 0 && run.status === 0 ? 0 : 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main()
  .then((status) => process.exit(status))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
