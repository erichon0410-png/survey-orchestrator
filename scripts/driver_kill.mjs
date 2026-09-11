// driver_kill.mjs — pkill -f pattern for a survey driver process.
//
// A driver's real argv is:
//   /usr/bin/node .../scripts/survey_driver.mjs --port 3015 --marker codex exec bound port 3015 ...
// The historical needle `survey_driver.*port=${port}` matched `port=3015`, which never
// occurs in that argv, so idle/auth-timeout kills silently no-opped (idle_kill_failed).
// This pattern anchors on the script name + explicit `--port N` argument and is safe at
// end-of-line. pkill -f takes POSIX ERE; only the driver matches — its SIGTERM handler
// cascades to the codex child, so we never kill the child directly.

export function driverKillPattern(port) {
  return `survey_driver\\.mjs --port ${Number(port)}( |$)`;
}
