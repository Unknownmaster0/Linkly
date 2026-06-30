// PreToolUse hook — fires before Edit/Write tool calls
// Prints a contract reminder when editing route/handler/service files
'use strict';

let raw = '';
process.stdin.on('data', chunk => { raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const filePath = (input.tool_input && input.tool_input.file_path) || '';
    const normalized = filePath.replace(/\\/g, '/');

    if (/\/(routes|handlers|middleware|errors|services)\//i.test(normalized)) {
      process.stdout.write(
        '\n[CONTRACT REMINDER] Route/handler/service file detected.\n' +
        'Before writing, verify:\n' +
        '  1. Response shape matches ../docs/notes/API_CONTRACT.md exactly\n' +
        '  2. All custom errors extend AppError hierarchy\n' +
        '     (ValidationError / AuthError / OwnershipError / NotFoundError / ConflictError / RateLimitError)\n' +
        '  3. Route handlers: ZERO try-catch for business or DB logic\n' +
        '  4. Ownership failures return 404, NEVER 403 (IDOR prevention)\n' +
        '  5. Redirect analytics: fire-and-forget, never awaited\n' +
        'Invoke /api-design for new routes, /error-handling for error code.\n\n'
      );
    }
  } catch (_) {
    // Non-JSON input or missing fields — do nothing, never block the tool
  }
  process.exit(0);
});
