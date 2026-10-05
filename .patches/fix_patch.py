from pathlib import Path
import re

# Preprocess the staging patch so it remains tolerant of the existing catch wording.
p = Path('.patches/v138_admin_live.py')
s = p.read_text(encoding='utf-8')
s2, n = re.subn(r"\nold_catch = \"\"\".*?index = replace_once\(index, old_catch, new_catch, 'conflict refresh'\)\n", "\n", s, count=1, flags=re.S)
if n != 1:
    raise SystemExit(f'expected one conflict-refresh patch block, found {n}')
p.write_text(s2, encoding='utf-8')
