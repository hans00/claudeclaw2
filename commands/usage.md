---
description: Show Claude Code rate-limit usage (5h window and weekly quota)
---

Read `~/.claude/usag-status.json` and report the current Claude Code usage. Do the following:

```bash
python3 - << 'PYEOF'
import json, os, time
from datetime import datetime, timezone

STATUS_FILE = os.path.expanduser("~/.claude/usag-status.json")

if not os.path.exists(STATUS_FILE):
    print("⚠ No usage data yet.")
    print("The statusLine hook needs to fire at least once.")
    print("Open any Claude Code session and run a turn — the hook captures usage on each statusLine refresh.")
    raise SystemExit(0)

with open(STATUS_FILE) as f:
    data = json.load(f)

now = time.time()
received_ts = data.get("_received_at_ts", 0)
age_mins = int((now - received_ts) / 60) if received_ts else None

rl = data.get("rate_limits") or {}
five = rl.get("five_hour") or {}
seven = rl.get("seven_day") or {}
status = rl.get("status", "")
cost = data.get("cost")

def pct(v):
    if v is None: return None
    try: return max(0, min(100, round(float(v))))
    except: return None

def reset_str(ts):
    if not ts: return "unknown"
    try:
        t = float(ts)
        if t < now: return "expired (reset occurred)"
        diff = int(t - now)
        d, rem = divmod(diff, 86400)
        h, rem = divmod(rem, 3600)
        m = rem // 60
        if d: return f"{d}d {h}h {m}m"
        if h: return f"{h}h {m}m"
        return f"{m}m"
    except: return "unknown"

five_pct = pct(five.get("used_percentage"))
seven_pct = pct(seven.get("used_percentage"))
five_reset = five.get("resets_at")
seven_reset = seven.get("resets_at")

# reset already passed → treat as 0%
if five_reset and float(five_reset) < now: five_pct = 0
if seven_reset and float(seven_reset) < now: seven_pct = 0

def bar(p, width=20):
    if p is None: return "[no data]"
    filled = round(p / 100 * width)
    color = "🟥" if p >= 90 else "🟨" if p >= 70 else "🟩"
    return f"[{'█' * filled}{'░' * (width - filled)}] {p}% {color}"

print("━━━ Claude Code Usage ━━━")
print()
print(f"5-hour window:  {bar(five_pct)}")
print(f"  resets in:   {reset_str(five_reset)}")
print()
print(f"Weekly (7-day): {bar(seven_pct)}")
print(f"  resets in:   {reset_str(seven_reset)}")

if status:
    print(f"\nStatus: {status}")
if cost is not None:
    try: print(f"Cost (session): ${float(cost):.4f}")
    except: pass

if age_mins is not None:
    stale = age_mins > 360
    tag = f" ⚠ ({age_mins}m ago — may be stale)" if stale else f" ({age_mins}m ago)"
    print(f"\nData captured:{tag}")
PYEOF
```

Format the output clearly. If the file doesn't exist, explain that the user needs to open a Claude Code session first to trigger the hook.
