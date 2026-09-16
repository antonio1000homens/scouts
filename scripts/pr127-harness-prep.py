from pathlib import Path

path = Path('lambdas/sqs2scouts/function/tests/test-persistence-handler.mjs')
text = path.read_text()
old = "test('real persistence handler exercises SQS messageBody occurrence hide and unhide boundaries', async () => {"
new = "test('real persistence handler exercises SQS messageBody occurrence hide and unhide', async () => {"
if text.count(old) != 1:
    raise SystemExit(f'expected one persistence test title, found {text.count(old)}')
path.write_text(text.replace(old, new, 1))
