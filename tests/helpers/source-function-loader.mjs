import vm from 'node:vm';

/**
 * Extract a named function declaration from a browser script without importing
 * the whole script (which would execute DOM startup code in Node).
 *
 * This intentionally supports the function styles used by the Scouts browser
 * scripts: `function name(...) {}` and `async function name(...) {}`.
 */
export function extractFunctionSource(source, functionName) {
  const matcher = new RegExp(`(?:async\\s+)?function\\s+${functionName.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}\\s*\\(`);
  const match = matcher.exec(source);
  if (!match) throw new Error(`Unable to find function ${functionName}`);

  const start = match.index;
  const bodyStart = source.indexOf('{', start + match[0].length);
  if (bodyStart < 0) throw new Error(`Unable to find body for ${functionName}`);

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`Unterminated function ${functionName}`);
}

export function loadFunctionsFromSource(source, functionNames, sandbox = {}) {
  const context = {
    console,
    setTimeout: () => 0,
    clearTimeout: () => {},
    ...sandbox,
  };
  const declarations = functionNames.map((name) => extractFunctionSource(source, name)).join('\n\n');
  const exportShape = functionNames.map((name) => `${JSON.stringify(name)}: ${name}`).join(', ');
  vm.runInNewContext(`${declarations}\nthis.__loadedFunctions = { ${exportShape} };`, context, {
    timeout: 1_000,
  });
  return { functions: context.__loadedFunctions, context };
}
