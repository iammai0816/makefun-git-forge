// Entry point for the forge: bring the HTTP server up, tell the trial
// environment which port it landed on, and keep serving until the
// environment reports that the suite has finished.
//
// The harness hands this process exactly one knob, the MAKEFUN_ENV_URL
// environment variable, pointing at the environment server. The
// conversation with that server has three moves:
//
//   1. POST {"port": <port>} to <env>/register — the environment notes
//      the address this request arrived from, pairs it with the port,
//      and dials the forge there from then on. Only the first
//      registration counts; a repeat is refused with 409.
//   2. GET <env>/done, over and over, until the body reads
//      {"done": true}. While the suite is still running the answer is
//      {"done": false} and comes back immediately, so this side polls
//      on a short pause rather than holding any request open.
//   3. Once done is true, shut the server down and leave with code 0.
//
// Nothing here exits early: a failed register or a failed poll is
// retried, and the process only finishes after the environment says so.
// When MAKEFUN_ENV_URL is absent there is no environment to talk to,
// so startup fails right away instead of serving into the void.

import { createApp } from "./app.ts";

// Name of the environment variable carrying the environment origin.
const ENV_URL_VARIABLE = "MAKEFUN_ENV_URL";

// Paths on the environment server for the two lifecycle calls.
const ANNOUNCE_PATH = "/register";
const FINISHED_PATH = "/done";

// How long one HTTP call to the environment may take before it is
// abandoned and retried. Done polls always answer at once, so a call
// that hangs this long is a broken connection, not a slow suite.
const CALL_TIMEOUT_MS = 30_000;

// Polling rhythm: start with a short pause between done checks and
// stretch it, doubling each time, up to a ceiling. Registration
// retries use the same shape, beginning even shorter.
const FIRST_DONE_PAUSE_MS = 250;
const FIRST_ANNOUNCE_PAUSE_MS = 100;
const LONGEST_PAUSE_MS = 2_000;

// The outcome code once the suite has finished.
const DONE_EXIT_CODE = 0;
const FAILED_EXIT_CODE = 1;

/** Wait out a pause without blocking the server. */
function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds));
  });
}

/** Stretch a pause for the next retry, never beyond the ceiling. */
function stretchPause(milliseconds: number): number {
  return Math.min(LONGEST_PAUSE_MS, milliseconds * 2);
}

/** The environment origin with any trailing slashes trimmed off. */
function envOrigin(): string | null {
  const raw = process.env[ENV_URL_VARIABLE];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.replace(/\/+$/, "");
}

/**
 * Announce the bound port to the environment. A 200 means the
 * registration landed; a 409 means one already did, which counts as
 * landed too, since the first registration is the one the suite dials.
 * Anything else — a refused connection, a timeout, an unexpected
 * status — is retried on a growing pause until it goes through.
 */
async function announcePort(origin: string, port: number): Promise<void> {
  let waitMs = FIRST_ANNOUNCE_PAUSE_MS;
  for (;;) {
    try {
      const reply = await fetch(`${origin}${ANNOUNCE_PATH}`, {
        body: JSON.stringify({ port }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      await reply.arrayBuffer().catch(() => undefined);
      if (reply.status === 200 || reply.status === 409) return;
      throw new Error(`register answered HTTP ${reply.status}`);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`register failed (${reason}); retrying\n`);
    }
    await pause(waitMs);
    waitMs = stretchPause(waitMs);
  }
}

/**
 * Ask the environment, again and again, whether the suite has
 * finished. Returns only when the answer is {"done": true}. A poll
 * that fails, times out, or carries an unexpected body is treated the
 * same as a "not yet" answer: pause a little longer and ask again.
 */
async function waitUntilDone(origin: string): Promise<void> {
  let waitMs = FIRST_DONE_PAUSE_MS;
  for (;;) {
    try {
      const reply = await fetch(`${origin}${FINISHED_PATH}`, {
        headers: { accept: "application/json" },
        method: "GET",
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      const payload: unknown = await reply.json().catch(() => null);
      const finished =
        typeof payload === "object" &&
        payload !== null &&
        (payload as Record<string, unknown>).done === true;
      if (reply.status === 200 && finished) return;
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`done poll failed (${reason}); retrying\n`);
    }
    await pause(waitMs);
    waitMs = stretchPause(waitMs);
  }
}

/** Start the forge, register it, and wait for the suite to finish. */
async function boot(): Promise<number> {
  const origin = envOrigin();
  if (origin === null) {
    process.stderr.write(`${ENV_URL_VARIABLE} is not set; nothing to register with\n`);
    return FAILED_EXIT_CODE;
  }

  const forge = createApp();

  // Bind port 0 and let the kernel choose an ephemeral port. Port 8080
  // is the environment's own, so it is never a candidate here.
  const boundPort = await new Promise<number>((resolve, reject) => {
    forge.once("error", reject);
    forge.listen(0, () => {
      const address = forge.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
      } else {
        reject(new Error("the server bound without an address"));
      }
    });
  });

  await announcePort(origin, boundPort);
  await waitUntilDone(origin);

  // The suite is over and its export is written. Stop accepting work
  // before leaving so no request is cut off mid-flight.
  await new Promise<void>((resolve) => {
    forge.close(() => resolve());
  });
  return DONE_EXIT_CODE;
}

try {
  process.exitCode = await boot();
} catch (cause) {
  const reason = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`forge failed to start: ${reason}\n`);
  process.exitCode = FAILED_EXIT_CODE;
}
