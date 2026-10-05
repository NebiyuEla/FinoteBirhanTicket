from pathlib import Path

path = Path('.patches/live_miniapp_availability.py')
text = path.read_text(encoding='utf-8')
# The staged patch accidentally encoded JS literal "\\n\\n" as two physical
# Python source lines. Normalize those matcher/replacement strings before applying.
bad = "\\\\\n\\\\\n"
good = "\\\\n\\\\n"
count = text.count(bad)
if count < 2:
    raise SystemExit(f'expected at least 2 malformed newline sequences, found {count}')
path.write_text(text.replace(bad, good), encoding='utf-8')
print(f'Normalized {count} Mini App patch newline sequence(s).')
