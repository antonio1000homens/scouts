from pathlib import Path

# The main transformation emits JavaScript regular-expression source in a few
# replacement strings. Make re.sub insert replacement text literally rather than
# interpreting backslashes such as \s as Python replacement escapes.
script_path = Path('scripts/pr127-hex-canonical-fix.py')
script = script_path.read_text()
old_sub = "text2, n = re.subn(pattern, repl, text, count=count, flags=flags)"
new_sub = "text2, n = re.subn(pattern, lambda _match: repl, text, count=count, flags=flags)"
if script.count(old_sub) != 1:
    raise SystemExit(f'expected one regex helper implementation, found {script.count(old_sub)}')
script_path.write_text(script.replace(old_sub, new_sub, 1))

path = Path('lambdas/sqs2scouts/function/tests/test-persistence-handler.mjs')
text = path.read_text()
old = "test('real persistence handler exercises SQS messageBody occurrence hide and unhide boundaries', async () => {"
new = "test('real persistence handler exercises SQS messageBody occurrence hide and unhide', async () => {"
if text.count(old) != 1:
    raise SystemExit(f'expected one persistence test title, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
