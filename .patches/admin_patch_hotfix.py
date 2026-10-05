from pathlib import Path

path = Path('.patches/admin_dashboard_accuracy.py')
text = path.read_text(encoding='utf-8')
old = "    am ? '⚙️ ተጨማሪ የአስተዳዳሪ እቃዎች\\n\\nአደገኛ የዳታ ማጥፋት ተግባር ከዋናው ዳሽቦርድ ተወግዷል።' : '⚙️ More admin tools\\n\\nDestructive data actions are intentionally kept away from the main dashboard.',"
new = "    am ? `⚙️ ተጨማሪ የአስተዳዳሪ እቃዎች\\n\\nአደገኛ የዳታ ማጥፋት ተግባር ከዋናው ዳሽቦርድ ተወግዷል።` : `⚙️ More admin tools\\n\\nDestructive data actions are intentionally kept away from the main dashboard.`,"
count = text.count(old)
if count != 1:
    raise SystemExit(f'admin More string: expected 1 match, found {count}')
path.write_text(text.replace(old, new, 1), encoding='utf-8')
print('Admin More template generator fixed.')
