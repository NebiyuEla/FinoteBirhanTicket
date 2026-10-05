from pathlib import Path

path = Path('bot/backend/src/index.js')
text = path.read_text(encoding='utf-8')
old = r"s.statsIssues.map((issue) => `• ${issue}`).join('\\\\n')"
new = r"s.statsIssues.map((issue) => `• ${issue}`).join('\n')"
count = text.count(old)
if count != 1:
    raise SystemExit(f'admin warning newline: expected 1 match, found {count}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Admin dashboard presentation tidy applied.')
