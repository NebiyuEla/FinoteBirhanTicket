from pathlib import Path
p = Path('bot/backend/tests/navigationRecoveryCore.test.js')
s = p.read_text(encoding='utf-8')
old = "assert.match(source, /Recovery attention:/);"
new = "assert.match(source, /Recovery:/);"
if old not in s:
    raise SystemExit('legacy Recovery attention assertion not found')
p.write_text(s.replace(old, new, 1), encoding='utf-8')
