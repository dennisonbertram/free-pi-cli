---
name: long-jobs
description: Use when running builds, test suites, dev servers, downloads, decompilers, or any command expected to take longer than about a minute. Covers checking tools first, running jobs in the background with a log, waiting once, and not hiding errors.
---

# Long-running jobs

- Before relying on a tool, check it exists once (`command -v gh cmake timeout`) and note what is missing. Do not assume `sudo`.
- Run the specific test or target first. Run a full suite once, at the end.
- Before rerunning a long job, check whether its earlier output or log already exists.
- Start long processes in the background with output to a log file and the PID saved: `nohup cmd > job.log 2>&1 & echo $! > job.pid`. Stop them with `kill $(cat job.pid)`. Never use `pkill -f` with a pattern that also matches your own command line.
- Wait once, with a time limit, for a marker in the log: `timeout 600 sh -c 'until grep -q "done" job.log; do sleep 5; done'`. To wait for the process instead: `timeout 600 sh -c 'while kill -0 $(cat job.pid) 2>/dev/null; do sleep 5; done'`. Do not poll with repeated short sleep-and-tail calls, and do not use `tail -f | grep` (it keeps waiting after the match).
- Check a port is free before starting a server, and stop the servers you started.
- Do not hide errors: no `2>/dev/null` and no `| tail` on a command whose failure you need to diagnose. Test a new parser or script on a small sample first.
