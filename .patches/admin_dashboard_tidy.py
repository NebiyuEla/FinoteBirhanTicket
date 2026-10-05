from pathlib import Path

path = Path('bot/backend/src/index.js')
text = path.read_text(encoding='utf-8')
# admin_dashboard_accuracy.py is a raw Python string, so its JS join delimiter
# lands as two backslashes + n. Normalize it to a real JS newline escape.
old = "s.statsIssues.map((issue) => `• ${issue}`).join('\\\\n')"
new = "s.statsIssues.map((issue) => `• ${issue}`).join('\\n')"
if old in text:
    text = text.replace(old, new, 1)
elif new not in text:
    raise SystemExit('admin warning newline expression was not found')
path.write_text(text, encoding='utf-8')
print('Admin dashboard presentation tidy applied.')
