import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
  existsSync,
  symlinkSync,
  readlinkSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { packageRelease } from "./package-release.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const SHA = "a".repeat(40),
  OLD = "b".repeat(40);
const runtime = { platform: "linux", arch: "x64", node: "24.0.0" };
function file(path, text, mode = 0o644) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, text, { mode });
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "personchat-cd-"));
  const source = join(root, "source"),
    output = join(root, "output");
  file(join(source, ".next/standalone/server.js"), "// fixture server\n");
  file(
    join(source, ".next/standalone/.env.production"),
    "DO_NOT_SHIP=private\n",
  );
  file(join(source, ".next/static/test.js"), "// static chunk\n");
  file(join(source, "public/test.txt"), "public\n");
  file(join(source, "app/mcp/mcp_config.default.json"), '{"mcpServers":{}}\n');
  file(
    join(source, ".next/standalone/node_modules/example/index.js"),
    "export default 1;\n",
  );
  symlinkSync(
    "index.js",
    join(source, ".next/standalone/node_modules/example/link.js"),
  );
  const nodeBinary = join(root, "node-stub");
  file(nodeBinary, "#!/bin/sh\nprintf 'v24.0.0\\n'\n", 0o755);
  return {
    root,
    source,
    output,
    nodeBinary,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("release includes standalone, static/public files and Node; excludes environment files", () => {
  const f = fixture();
  try {
    packageRelease({ ...f, sha: SHA, runtime });
    const unpack = join(f.root, "unpack");
    mkdirSync(unpack);
    assert.equal(
      spawnSync("tar", ["-xzf", join(f.output, "release.tgz"), "-C", unpack])
        .status,
      0,
    );
    for (const p of [
      "server.js",
      ".next/static/test.js",
      "public/test.txt",
      "runtime/node",
    ])
      assert.ok(existsSync(join(unpack, p)), p);
    // The service runs as a different user than the deploy account. The
    // archive root and the bundled runtime must be traversable/executable.
    assert.equal(statSync(unpack).mode & 0o777, 0o755);
    assert.equal(statSync(join(unpack, "runtime/node")).mode & 0o777, 0o755);
    assert.ok(!existsSync(join(unpack, ".env.production")));
    assert.equal(
      readlinkSync(join(unpack, "node_modules/example/link.js")),
      "index.js",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(unpack, "public/personchat-release.json"))),
      { sha: SHA },
    );
    assert.deepEqual(JSON.parse(readFileSync(join(unpack, "release.json"))), {
      sha: SHA,
      ...runtime,
    });
    assert.match(
      readFileSync(join(f.output, "release.tgz.sha256"), "utf8"),
      /^[a-f0-9]{64}  release\.tgz\n$/,
    );
  } finally {
    f.cleanup();
  }
});

test("packaging rejects incompatible runtime, invalid SHA and incomplete builds", () => {
  const f = fixture();
  try {
    for (const bad of [
      { ...runtime, platform: "darwin" },
      { ...runtime, arch: "arm64" },
      { ...runtime, node: "22.0.0" },
    ]) {
      assert.throws(
        () => packageRelease({ ...f, sha: SHA, runtime: bad }),
        /Linux x64/,
      );
    }
    assert.throws(
      () => packageRelease({ ...f, sha: "main", runtime }),
      /full commit/,
    );
    rmSync(join(f.source, ".next/standalone/server.js"));
    assert.throws(
      () => packageRelease({ ...f, sha: SHA, runtime }),
      /Missing build/,
    );
  } finally {
    f.cleanup();
  }
});

function serverFixture(previous = true) {
  const f = fixture();
  const root = join(f.root, "deploy"),
    bin = join(f.root, "bin"),
    state = join(f.root, "state.json");
  mkdirSync(bin);
  mkdirSync(join(root, "releases"), { recursive: true });
  writeFileSync(state, JSON.stringify({ restarts: 0, stops: 0, active: true }));
  // Adapters for the host's CLI differences. Only systemctl/curl are fake; the actual
  // archive, manifest validation, symlink switch, trap and rollback script are executed.
  file(
    join(bin, "uname"),
    '#!/bin/sh\nif [ "$1" = -s ]; then echo Linux; else echo x86_64; fi\n',
    0o755,
  );
  file(join(bin, "sleep"), "#!/bin/sh\nexit 0\n", 0o755);
  file(
    join(bin, "sudo"),
    '#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n',
    0o755,
  );
  file(
    join(bin, "mv"),
    `#!/usr/bin/env python3
import os,sys,signal
os.replace(sys.argv[-2],sys.argv[-1])
if os.environ.get("TEST_SIGNAL_AFTER_MV") in ("TERM","HUP"):
    flag=os.environ["TEST_SIGNAL_FLAG"]
    if not os.path.exists(flag):
        open(flag,"w").close()
        os.kill(os.getppid(), getattr(signal, "SIG"+os.environ["TEST_SIGNAL_AFTER_MV"]))
`,
    0o755,
  );
  file(
    join(bin, "flock"),
    "#!/usr/bin/env python3\nimport fcntl,sys\ntry: fcntl.flock(int(sys.argv[-1]),fcntl.LOCK_EX|fcntl.LOCK_NB)\nexcept BlockingIOError: sys.exit(1)\n",
    0o755,
  );
  file(
    join(bin, "sha256sum"),
    "#!/usr/bin/env python3\nimport hashlib,sys\nexpected,name=open(sys.argv[-1]).read().split()\nsys.exit(0 if hashlib.sha256(open(name,'rb').read()).hexdigest()==expected else 1)\n",
    0o755,
  );
  file(
    join(bin, "systemctl"),
    `#!/usr/bin/env node
import fs from 'node:fs';
const p=process.env.TEST_STATE,s=JSON.parse(fs.readFileSync(p));
const action=process.argv[2];
if(action==='restart'){
 s.restarts++;s.active=true;fs.writeFileSync(p,JSON.stringify(s));
 const sha=JSON.parse(fs.readFileSync(process.env.TEST_ROOT+'/current/release.json')).sha;
 if(process.env.TEST_RESTART_FAIL===sha) process.exit(1);
}else if(action==='stop'){
 s.stops++;s.active=false;fs.writeFileSync(p,JSON.stringify(s));
 if(process.env.TEST_STOP_FAIL==="1") process.exit(1);
}
else if(action==='is-active')process.exit(s.active?0:1);
`,
    0o755,
  );
  file(
    join(bin, "curl"),
    `#!/usr/bin/env node
import fs from 'node:fs';
const sha=JSON.parse(fs.readFileSync(process.env.TEST_ROOT+'/current/release.json')).sha;
if(sha===process.env.TEST_FAIL_SHA)process.exit(22);
if(process.argv.at(-1).endsWith('/backend-api/auth/session') && sha===process.env.TEST_BAD_PROXY)process.exit(22);
if(process.argv.at(-1).endsWith('/personchat-release.json'))console.log(JSON.stringify({sha:process.env.TEST_WRONG_MARKER===sha?'c'.repeat(40):sha}));
else if(process.argv.at(-1).endsWith('/backend-api/auth/session'))console.log(JSON.stringify({data:{authenticated:false}}));
else console.log('<html>ok</html>');
`,
    0o755,
  );
  // Node CLI mock files are .mjs so Node 22/24 also treat them as ESM.
  for (const name of ["systemctl", "curl"]) {
    const script = readFileSync(join(bin, name), "utf8");
    file(join(bin, name + ".mjs"), script.replace(/^#!.*\n/, ""));
    file(
      join(bin, name),
      `#!/bin/sh\nexec '${process.execPath}' '${join(
        bin,
        name + ".mjs",
      )}' "$@"\n`,
      0o755,
    );
  }
  if (previous) {
    const old = join(root, "releases/previous");
    mkdirSync(old);
    file(join(old, "release.json"), JSON.stringify({ sha: OLD }));
    symlinkSync(old, join(root, "current"));
  }
  const incoming = join(root, `incoming/${SHA}-1-1`);
  packageRelease({ ...f, output: incoming, sha: SHA, runtime });
  return {
    ...f,
    deployRoot: root,
    incoming,
    state,
    run(extra = {}) {
      return spawnSync(
        "bash",
        [join(here, "deploy.sh"), root, SHA, "3000", "personchat-front", "1-1"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            TEST_ROOT: root,
            TEST_STATE: state,
            ...extra,
          },
        },
      );
    },
    stateValue() {
      return JSON.parse(readFileSync(state));
    },
  };
}

test("successful deployment switches to the exact SHA", () => {
  const f = serverFixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readlinkSync(join(f.deployRoot, "current")),
      new RegExp(`${SHA}-1-1$`),
    );
    assert.equal(
      statSync(join(f.deployRoot, "releases", `${SHA}-1-1`)).mode & 0o777,
      0o755,
    );
    assert.equal(f.stateValue().restarts, 1);
  } finally {
    f.cleanup();
  }
});

for (const signalName of ["TERM", "HUP"]) {
  test(`switch-time ${signalName} restores the previous release`, () => {
    const f = serverFixture();
    try {
      const result = f.run({
        TEST_SIGNAL_AFTER_MV: signalName,
        TEST_SIGNAL_FLAG: join(f.root, `switch-${signalName}.flag`),
      });
      assert.notEqual(result.status, 0);
      assert.equal(
        readlinkSync(join(f.deployRoot, "current")),
        join(f.deployRoot, "releases/previous"),
      );
      assert.match(result.stderr, /Previous release restored/);
    } finally {
      f.cleanup();
    }
  });
}

test("post-commit output failure does not roll back the verified release", () => {
  const f = serverFixture();
  try {
    const result = f.run({ TEST_FAIL_AFTER_COMMIT: "1" });
    assert.notEqual(result.status, 0);
    assert.equal(
      readlinkSync(join(f.deployRoot, "current")),
      join(f.deployRoot, "releases", `${SHA}-1-1`),
    );
    assert.equal(f.stateValue().restarts, 1);
    assert.doesNotMatch(result.stderr, /restoring previous release/);
  } finally {
    f.cleanup();
  }
});

test("rollback failure returns nonzero with an explicit warning", () => {
  const f = serverFixture();
  try {
    const result = f.run({
      TEST_FAIL_SHA: SHA,
      TEST_RESTART_FAIL: OLD,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK FAILED/);
    assert.equal(
      readlinkSync(join(f.deployRoot, "current")),
      join(f.deployRoot, "releases/previous"),
    );
    assert.equal(f.stateValue().restarts, 2);
  } finally {
    f.cleanup();
  }
});

test("failed first release stop failure is reported and current is retained", () => {
  const f = serverFixture(false);
  try {
    const result = f.run({ TEST_FAIL_SHA: SHA, TEST_STOP_FAIL: "1" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /ROLLBACK FAILED/);
    assert.equal(
      readlinkSync(join(f.deployRoot, "current")),
      join(f.deployRoot, "releases", `${SHA}-1-1`),
    );
    assert.equal(f.stateValue().stops, 1);
  } finally {
    f.cleanup();
  }
});

for (const [label, extra] of [
  ["failed health", { TEST_FAIL_SHA: SHA }],
  ["backend proxy failure", { TEST_BAD_PROXY: SHA }],
  ["wrong version marker", { TEST_WRONG_MARKER: SHA }],
  ["failed restart", { TEST_RESTART_FAIL: SHA }],
]) {
  test(`${label} restores the previous release and still fails the deployment`, () => {
    const f = serverFixture();
    try {
      const result = f.run(extra);
      assert.notEqual(result.status, 0);
      assert.equal(
        readlinkSync(join(f.deployRoot, "current")),
        join(f.deployRoot, "releases/previous"),
      );
      assert.equal(f.stateValue().restarts, 2, result.stderr);
      assert.match(result.stderr, /Previous release restored/);
    } finally {
      f.cleanup();
    }
  });
}

test("failed first release is stopped without deleting its evidence", () => {
  const f = serverFixture(false);
  try {
    const result = f.run({ TEST_FAIL_SHA: SHA });
    assert.notEqual(result.status, 0);
    assert.ok(!existsSync(join(f.deployRoot, "current")));
    assert.equal(f.stateValue().stops, 1);
    assert.ok(
      existsSync(join(f.deployRoot, `releases/${SHA}-1-1/release.json`)),
    );
  } finally {
    f.cleanup();
  }
});

test("corrupt archive is rejected before switching or restarting", () => {
  const f = serverFixture();
  try {
    file(join(f.incoming, "release.tgz"), "corrupt");
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(f.stateValue().restarts, 0);
    assert.equal(
      readlinkSync(join(f.deployRoot, "current")),
      join(f.deployRoot, "releases/previous"),
    );
  } finally {
    f.cleanup();
  }
});

test("archive traversal is rejected before extraction", () => {
  const f = serverFixture();
  try {
    const result = spawnSync(
      "python3",
      [
        "-c",
        `import io,tarfile,hashlib,os
p=${JSON.stringify(f.incoming)}
with tarfile.open(p+'/release.tgz','w:gz') as t:
 i=tarfile.TarInfo('../outside');i.size=1;t.addfile(i,io.BytesIO(b'x'))
open(p+'/release.tgz.sha256','w').write(hashlib.sha256(open(p+'/release.tgz','rb').read()).hexdigest()+'  release.tgz\\n')
`,
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(f.run().status, 0);
    assert.equal(f.stateValue().restarts, 0);
    assert.ok(!existsSync(join(f.deployRoot, "releases/outside")));
  } finally {
    f.cleanup();
  }
});

test("SSH config rejects command injection before attempting a connection", () => {
  const root = mkdtempSync(join(tmpdir(), "personchat-cd-ssh-"));
  try {
    const result = spawnSync("bash", [join(here, "push-release.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        RUNNER_TEMP: root,
        FRONTEND_DEPLOY_HOST: "host; touch injected",
        FRONTEND_DEPLOY_USER: "deploy",
        FRONTEND_SSH_KEY: "synthetic",
        FRONTEND_KNOWN_HOSTS: "synthetic",
        GITHUB_SHA: SHA,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    assert.equal(result.status, 2);
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("previous symlink cannot escape the managed releases directory", () => {
  const f = serverFixture(false);
  try {
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    file(join(outside, "release.json"), JSON.stringify({ sha: OLD }));
    const link = f.deployRoot + "/releases/../../outside";
    symlinkSync(link, join(f.deployRoot, "current"));
    const result = f.run();
    assert.notEqual(result.status, 0);
    assert.equal(f.stateValue().restarts, 0);
    assert.equal(readlinkSync(join(f.deployRoot, "current")), link);
  } finally {
    f.cleanup();
  }
});

test(
  "server lock rejects a concurrent deployment before switching",
  { timeout: 5000 },
  async () => {
    const f = serverFixture();
    const holder = spawn("python3", [
      "-u",
      "-c",
      "import fcntl,sys,time; f=open(sys.argv[1],'w'); fcntl.flock(f,fcntl.LOCK_EX); print('ready',flush=True); time.sleep(30)",
      join(f.deployRoot, ".deploy.lock"),
    ]);
    try {
      await once(holder.stdout, "data");
      const result = f.run();
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /server lock/);
      assert.equal(f.stateValue().restarts, 0);
    } finally {
      holder.kill();
      await once(holder, "exit");
      f.cleanup();
    }
  },
);

test("SSH failure removes temporary keys without exposing their content", () => {
  const root = mkdtempSync(join(tmpdir(), "personchat-cd-ssh-"));
  try {
    const bin = join(root, "bin"),
      runner = join(root, "runner");
    mkdirSync(bin);
    mkdirSync(runner);
    file(join(bin, "ssh-keygen"), "#!/bin/sh\nexit 0\n", 0o755);
    file(join(bin, "ssh"), "#!/bin/sh\nexit 255\n", 0o755);
    const result = spawnSync("bash", [join(here, "push-release.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: bin + ":" + process.env.PATH,
        RUNNER_TEMP: runner,
        FRONTEND_DEPLOY_HOST: "example.test",
        FRONTEND_DEPLOY_USER: "deploy",
        FRONTEND_SSH_KEY: "synthetic-private-content",
        FRONTEND_KNOWN_HOSTS: "synthetic-host-key",
        GITHUB_SHA: SHA,
        GITHUB_RUN_ID: "1",
        GITHUB_RUN_ATTEMPT: "1",
      },
    });
    assert.equal(result.status, 255);
    assert.deepEqual(readdirSync(runner), []);
    assert.ok(
      !(result.stdout + result.stderr).includes("synthetic-private-content"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
